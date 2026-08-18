import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomEditor } from './Editor';
import { ProseMirrorEditorController } from './prosemirrorController';
import * as css from './Editor.css';

let isIosApp = false;
let nativeClipboardText = '';

vi.mock(import('$utils/platform'), async (importOriginal) => ({
  ...(await importOriginal()),
  iosApp: () => isIosApp,
}));

vi.mock(import('$utils/dom'), async (importOriginal) => ({
  ...(await importOriginal()),
  readClipboardText: () => Promise.resolve(nativeClipboardText),
}));

const emptyClientRects = () => [] as unknown as DOMRectList;
beforeAll(() => {
  Element.prototype.getClientRects ??= emptyClientRects;
  (Text.prototype as unknown as Element).getClientRects ??= emptyClientRects;
});

beforeEach(() => {
  isIosApp = false;
  nativeClipboardText = '';
});

// vanilla-extract composed styles resolve to several class names, so a plain
// `.${style}` selector would read as a descendant selector.
const byStyle = (container: HTMLElement, className: string) =>
  container.querySelector(`.${className.trim().split(/\s+/).join('.')}`);

const renderEditor = (props: Partial<Parameters<typeof CustomEditor>[0]> = {}) => {
  const editor = props.editor ?? new ProseMirrorEditorController();
  const result = render(
    <CustomEditor
      editableName="TestEditor"
      editor={editor}
      placeholder="Write a message"
      {...props}
    />
  );
  return { editor, ...result };
};

const row = (container: HTMLElement) => byStyle(container, css.EditorRow)!;
const maxHeightOf = (container: HTMLElement) =>
  (byStyle(container, css.EditorTextareaScroll) as HTMLElement).style.maxHeight;

describe('CustomEditor', () => {
  it('mounts a ProseMirror editable surface with the placeholder', () => {
    const { container } = renderEditor();

    expect(container.querySelector('[aria-label="Write a message"]')).toBeTruthy();
    expect(container.querySelector('.ProseMirror')).toBeTruthy();
  });

  it('keeps focus on the editable when the document is cleared', () => {
    const { container, editor } = renderEditor();
    const editable = container.querySelector('.ProseMirror') as HTMLElement;
    editable.focus();

    act(() => editor.insertText('some text'));
    act(() => editor.clear());

    expect(editor.isEmpty()).toBe(true);
    expect(document.activeElement).toBe(editable);
  });

  it('notifies document-change consumers when cleared so autocomplete closes', () => {
    const { editor } = renderEditor();
    const changes: string[] = [];
    editor.subscribe(() => changes.push(editor.getText()));

    act(() => editor.insertText('hello'));
    expect(editor.getAutocompleteQuery(['h', 'he'])).toBeDefined();

    act(() => editor.clear());

    expect(changes).toEqual(['hello', '']);
    expect(editor.getAutocompleteQuery(['h', 'he'])).toBeUndefined();
  });
});

describe('CustomEditor layout', () => {
  it('keeps buttons inline for a single line', () => {
    const { container } = renderEditor({ after: <button type="button">Send</button> });

    expect(row(container)).not.toHaveClass(css.EditorRowMultiline);
  });

  it('keeps buttons inline however long the text is', async () => {
    const { container, editor } = renderEditor({ after: <button type="button">Send</button> });

    act(() => editor.insertText('text long enough to wrap several times over in the composer'));

    await waitFor(() => expect(editor.isEmpty()).toBe(false));
    expect(row(container)).not.toHaveClass(css.EditorRowMultiline);
  });

  it('keeps buttons inline across many paragraphs', async () => {
    const { container, editor } = renderEditor({ after: <button type="button">Send</button> });

    act(() => editor.insertText('one'));
    act(() => editor.insertNewline());
    act(() => editor.insertText('two'));

    await waitFor(() => expect(editor.getText()).toBe('one\ntwo'));
    expect(row(container)).not.toHaveClass(css.EditorRowMultiline);
  });

  it('never installs a hidden measurer', () => {
    const { container, editor } = renderEditor({ after: <button type="button">Send</button> });

    act(() => editor.insertText('some text'));

    expect(container.querySelector('[data-editor-measurer]')).toBeNull();
  });

  it('stacks the layout and moves responsive content into the footer when forced', () => {
    const { container } = renderEditor({
      after: <button type="button">Send</button>,
      responsiveAfter: <div data-testid="recorder">Recorder</div>,
      forceMultilineLayout: true,
    });

    expect(row(container)).toHaveClass(css.EditorRowMultiline);
    expect(row(container)).toHaveClass(css.EditorRowMultilineWithResponsiveAfter);
    expect(byStyle(container, css.EditorResponsiveAfterMultiline)).toContainElement(
      screen.getByTestId('recorder')
    );
    expect(maxHeightOf(container)).toBe('');
  });

  it('keeps responsive content inline when not forced', () => {
    const { container } = renderEditor({
      after: <button type="button">Send</button>,
      responsiveAfter: <div data-testid="recorder">Recorder</div>,
    });

    expect(byStyle(container, css.EditorResponsiveAfterMultiline)).toBeNull();
    expect(screen.getByTestId('recorder')).toBeInTheDocument();
    expect(maxHeightOf(container)).toBe('50dvh');
  });
});

const pasteWith = (container: HTMLElement, clipboardData: Record<string, string>) => {
  fireEvent.paste(container.querySelector('.ProseMirror')!, {
    clipboardData: {
      getData: (format: string) => clipboardData[format] ?? '',
      files: [],
      types: Object.keys(clipboardData),
    },
  });
};

describe('CustomEditor paste', () => {
  it('reads the native clipboard when the ios webview delivers an empty paste event', async () => {
    isIosApp = true;
    nativeClipboardText = 'from the native clipboard';
    const { container, editor } = renderEditor();

    pasteWith(container, { 'text/plain': '' });

    await waitFor(() => expect(editor.getText()).toBe('from the native clipboard'));
  });

  it('leaves an empty paste event alone outside the ios webview', async () => {
    isIosApp = false;
    nativeClipboardText = 'from the native clipboard';
    const { container, editor } = renderEditor();

    pasteWith(container, { 'text/plain': '' });

    await Promise.resolve();
    expect(editor.getText()).toBe('');
  });

  it('does not read the native clipboard when the event already carries text', async () => {
    isIosApp = true;
    nativeClipboardText = 'from the native clipboard';
    const { container, editor } = renderEditor();

    pasteWith(container, { 'text/plain': 'real clipboard text' });

    await Promise.resolve();
    expect(editor.getText()).not.toBe('from the native clipboard');
  });

  it('lets a consumer handler pre-empt the native clipboard fallback', async () => {
    isIosApp = true;
    nativeClipboardText = 'from the native clipboard';
    const { container, editor } = renderEditor({
      onPaste: (event) => event.preventDefault(),
    });

    pasteWith(container, { 'text/plain': '' });

    await Promise.resolve();
    expect(editor.getText()).toBe('');
  });
});
