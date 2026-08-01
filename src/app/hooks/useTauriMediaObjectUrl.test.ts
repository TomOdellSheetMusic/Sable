// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const isTauriMock = vi.fn<() => boolean>(() => true);
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => isTauriMock(),
}));

import {
  getTauriMediaObjectUrl,
  tauriMediaObjectUrlTestHooks,
  useTauriMediaObjectUrl,
} from './useTauriMediaObjectUrl';

const SRC = 'http://sable-media.localhost/https%3A%2F%2fexample.org%2F_matrix%2Fmedia%2Fv3%2Fdownload%2Fa%2Fb?__sable_media_cache=3';

const mockFetchResolve = (body = 'image-bytes') =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(new Response(body, { status: 200 })));

let createdUrls: string[];

beforeEach(() => {
  isTauriMock.mockReturnValue(true);
  createdUrls = [];
  let counter = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn<() => string>(() => {
      counter += 1;
      const url = `blob:mock-${counter}`;
      createdUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn<() => void>(),
  });
  tauriMediaObjectUrlTestHooks.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useTauriMediaObjectUrl', () => {
  it('passes through untouched outside Tauri', async () => {
    isTauriMock.mockReturnValue(false);
    const fetchSpy = mockFetchResolve();

    const { result } = renderHook(() => useTauriMediaObjectUrl(SRC));

    expect(result.current).toBe(SRC);
    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
  });

  it('resolves to a cached object URL and fetches only once per URL', async () => {
    const fetchSpy = mockFetchResolve();

    const first = renderHook(() => useTauriMediaObjectUrl(SRC));
    expect(first.result.current).toBeUndefined();
    await waitFor(() => expect(first.result.current).toBe('blob:mock-1'));

    const second = renderHook(() => useTauriMediaObjectUrl(SRC));
    expect(second.result.current).toBe('blob:mock-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw URL when the fetch fails, and retries on remount', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(new Response('image-bytes', { status: 200 }));

    const first = renderHook(() => useTauriMediaObjectUrl(SRC));
    await waitFor(() => expect(first.result.current).toBe(SRC));
    first.unmount();

    const second = renderHook(() => useTauriMediaObjectUrl(SRC));
    await waitFor(() => expect(second.result.current).toBe('blob:mock-1'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns undefined until the fetch resolves', async () => {
    let release!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );

    const { result } = renderHook(() => useTauriMediaObjectUrl(SRC));
    expect(result.current).toBeUndefined();

    release(new Response('image-bytes', { status: 200 }));
    await waitFor(() => expect(result.current).toBe('blob:mock-1'));
  });

  it('dedupes concurrent mounts of the same URL', async () => {
    const fetchSpy = mockFetchResolve();

    const a = renderHook(() => useTauriMediaObjectUrl(SRC));
    const b = renderHook(() => useTauriMediaObjectUrl(SRC));

    await waitFor(() => {
      expect(a.result.current).toBe('blob:mock-1');
      expect(b.result.current).toBe('blob:mock-1');
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps changes of src independent', async () => {
    mockFetchResolve();
    const OTHER = `${SRC}&other=1`;

    const { result, rerender } = renderHook(({ src }) => useTauriMediaObjectUrl(src), {
      initialProps: { src: SRC },
    });
    await waitFor(() => expect(result.current).toBe('blob:mock-1'));

    rerender({ src: OTHER });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe('blob:mock-2'));

    // SRC is still cached and resolves synchronously.
    expect(getTauriMediaObjectUrl(SRC)).toBe('blob:mock-1');
  });
});
