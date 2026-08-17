import type {
  ClipboardEventHandler,
  KeyboardEventHandler,
  MutableRefObject,
  ReactNode,
} from 'react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Scroll } from 'folds';
import { iosApp, isMobileOrTablet } from '$utils/platform';
import { readClipboardText } from '$utils/dom';
import { createLogger } from '$utils/debug';
import { useSetting } from '$state/hooks/settings';
import { settingsAtom } from '$state/settings';
import type { EditorDocument } from './model';
import { ProseMirrorEditable } from './ProseMirrorEditable';
import { ProseMirrorEditorController } from './prosemirrorController';
import { toggleProseMirrorKeyboardShortcut } from './keyboard';
import { useEditorRenderContext } from './useEditorRenderContext';
import * as css from './Editor.css';

export const useEditor = (): ProseMirrorEditorController => {
  const [editor] = useState(() => new ProseMirrorEditorController());
  const renderContext = useEditorRenderContext();
  useEffect(() => {
    editor.setRenderContext(renderContext);
  }, [editor, renderContext]);
  return editor;
};

const log = createLogger('Editor');

type CustomEditorProps = {
  after?: ReactNode;
  before?: ReactNode;
  bottom?: ReactNode;
  className?: string;
  editableName?: string;
  editor: ProseMirrorEditorController;
  enterKeyHint?: 'enter' | 'send';
  forceMultilineLayout?: boolean;
  maxHeight?: string;
  onChange?: (value: EditorDocument) => void;
  onKeyDown?: KeyboardEventHandler;
  onKeyUp?: KeyboardEventHandler;
  onPaste?: ClipboardEventHandler;
  placeholder?: string;
  responsiveAfter?: ReactNode;
  suppressBlurRefocusRef?: MutableRefObject<boolean>;
  top?: ReactNode;
  variant?: 'Surface' | 'SurfaceVariant' | 'Background';
};

/**
 * Visual shell for the Sable editor. Its interface is engine-neutral: callers
 * interact with a controller and Sable documents, never an editor engine state.
 */
export const CustomEditor = forwardRef<HTMLDivElement, CustomEditorProps>(
  (
    {
      after,
      before,
      bottom,
      className,
      editableName,
      editor,
      enterKeyHint,
      forceMultilineLayout = false,
      maxHeight = '50dvh',
      onChange,
      onKeyDown,
      onKeyUp,
      onPaste,
      placeholder,
      responsiveAfter,
      suppressBlurRefocusRef,
      variant = 'SurfaceVariant',
      top,
    },
    ref
  ) => {
    const [shortcutOverrides] = useSetting(settingsAtom, 'shortcutOverrides');
    const [alwaysInlineEditor] = useSetting(settingsAtom, 'alwaysInlineEditor');
    const rootRef = useRef<HTMLDivElement | null>(null);
    const focusScrollTimerRef = useRef<number>();

    // Buttons stay inline however tall the composer grows; only the audio
    // recorder stacks, because its controls need a row of their own.
    const layoutIsMultiline = !alwaysInlineEditor && forceMultilineLayout;
    const showResponsiveAfterInFooter = Boolean(responsiveAfter) && layoutIsMultiline;

    useEffect(() => () => window.clearTimeout(focusScrollTimerRef.current), []);
    const handleKeyDown: KeyboardEventHandler = useCallback(
      (event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          toggleProseMirrorKeyboardShortcut(editor, event, shortcutOverrides)
        ) {
          event.preventDefault();
        }
      },
      [editor, onKeyDown, shortcutOverrides]
    );
    const handlePaste: ClipboardEventHandler = useCallback(
      (event) => {
        onPaste?.(event);
        if (event.defaultPrevented || !iosApp() || event.clipboardData.getData('text/plain'))
          return;
        event.preventDefault();
        readClipboardText()
          .then((text) => text && editor.insertText(text))
          .catch((error: unknown) =>
            log.warn('Failed to read the native clipboard on paste:', error)
          );
      },
      [editor, onPaste]
    );

    const setRootRef = useCallback(
      (element: HTMLDivElement | null) => {
        rootRef.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
      },
      [ref]
    );
    const handleDocumentChange = useCallback(
      (document: EditorDocument) => {
        onChange?.(document);
      },
      [onChange]
    );

    return (
      <div ref={setRootRef} className={`${css.Editor} ${className ?? ''}`}>
        {top}
        <Box
          className={`${css.EditorRow} ${layoutIsMultiline ? css.EditorRowMultiline : ''} ${showResponsiveAfterInFooter ? css.EditorRowMultilineWithResponsiveAfter : ''}`}
          alignItems="Start"
          style={{ display: after ? 'grid' : 'flex' }}
        >
          {before && (
            <Box
              className={`${css.EditorOptions} ${layoutIsMultiline ? css.EditorOptionsMultiline : ''}`}
              alignItems="Center"
              gap="100"
              shrink="No"
            >
              {before}
            </Box>
          )}
          <Scroll
            className={`${css.EditorTextareaScroll} ${layoutIsMultiline ? css.EditorTextareaScrollMultiline : ''}`}
            variant={variant}
            style={{ maxHeight: showResponsiveAfterInFooter ? undefined : maxHeight }}
            size="300"
            visibility="Always"
            hideTrack
          >
            <ProseMirrorEditable
              controller={editor}
              editableName={editableName}
              editorClassName={`${css.EditorTextarea} ${alwaysInlineEditor ? css.EditorTextareaInline : ''}`}
              placeholder={placeholder}
              enterKeyHint={enterKeyHint}
              onDocumentChange={handleDocumentChange}
              onKeyDown={handleKeyDown}
              onKeyUp={onKeyUp}
              onPaste={handlePaste}
              onBlur={(event) => {
                if (!isMobileOrTablet() || suppressBlurRefocusRef?.current) return;
                const next = event.relatedTarget as HTMLElement | null;
                if (!next || (next !== event.currentTarget && next.isContentEditable)) return;
                editor.focus();
              }}
              onFocus={() => {
                if (!isMobileOrTablet()) return;
                const editable = document.activeElement;
                window.clearTimeout(focusScrollTimerRef.current);
                const scrollIntoView = () => {
                  if (editable && editable === document.activeElement) {
                    rootRef.current?.scrollIntoView({ block: 'nearest' });
                  }
                };
                window.visualViewport?.addEventListener('resize', scrollIntoView, { once: true });
                focusScrollTimerRef.current = window.setTimeout(scrollIntoView, 500);
              }}
            />
          </Scroll>
          {(after || (responsiveAfter && !showResponsiveAfterInFooter)) && (
            <Box
              className={`${css.EditorOptions} ${layoutIsMultiline ? `${css.EditorOptionsMultiline} ${css.EditorOptionsAfterMultiline}` : ''}`}
              alignItems="Center"
              gap="100"
              shrink="No"
            >
              {!showResponsiveAfterInFooter && responsiveAfter}
              {after}
            </Box>
          )}
          {showResponsiveAfterInFooter && (
            <Box
              className={css.EditorResponsiveAfterMultiline}
              alignItems="Center"
              justifyContent="End"
              gap="100"
            >
              {responsiveAfter}
            </Box>
          )}
        </Box>
        {bottom}
      </div>
    );
  }
);
