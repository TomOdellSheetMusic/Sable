import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const swMediaAuth = vi.hoisted(() => ({
  getCachedSWMediaAuthSupport: vi.fn<() => boolean | undefined>(),
  probeSWMediaAuthSupport: vi.fn<() => Promise<boolean>>(async () => false),
  subscribeSWMediaAuthSupport: vi.fn<() => () => void>(() => () => {}),
}));

const mediaTransport = vi.hoisted(() => ({
  fetchMediaBlob: vi.fn<(url: string) => Promise<Blob>>(),
  getCurrentMediaSessionScope: vi.fn<() => string>(() => 'anonymous'),
  getStableMediaCacheKeyFragment: vi.fn<(url: string) => string>((url) => url),
}));

const tauriApi = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  invoke: vi.fn<(cmd: string, args: { url: string }) => Promise<string>>(),
  convertFileSrc: vi.fn<(url: string, protocol: string) => string>(
    (url: string, protocol: string) => `${protocol}://${url}`
  ),
}));

const LOOPBACK_URL = 'http://127.0.0.1:45678/capability';

vi.mock('$utils/swMediaAuth', () => swMediaAuth);
vi.mock('$utils/mediaTransport', () => mediaTransport);
vi.mock('@tauri-apps/api/core', () => tauriApi);

// The out-of-band retry preload never fires in jsdom, so tests drive it explicitly.
class StubImage {
  src = '';

  crossOrigin: string | null = null;

  private readonly handlers = new Map<string, Set<() => void>>();

  constructor() {
    imageProbes.push(this);
  }

  addEventListener(type: string, handler: () => void): void {
    const existing = this.handlers.get(type) ?? new Set<() => void>();
    existing.add(handler);
    this.handlers.set(type, existing);
  }

  removeEventListener(type: string, handler: () => void): void {
    this.handlers.get(type)?.delete(handler);
  }

  emit(type: string): void {
    this.handlers.get(type)?.forEach((handler) => handler());
  }
}

const imageProbes: StubImage[] = [];

describe('useRenderableMediaUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    swMediaAuth.getCachedSWMediaAuthSupport.mockReset();
    swMediaAuth.getCachedSWMediaAuthSupport.mockReturnValue(false);
    swMediaAuth.probeSWMediaAuthSupport.mockReset();
    swMediaAuth.probeSWMediaAuthSupport.mockResolvedValue(false);
    swMediaAuth.subscribeSWMediaAuthSupport.mockReset();
    swMediaAuth.subscribeSWMediaAuthSupport.mockReturnValue(() => {});
    mediaTransport.fetchMediaBlob.mockReset();
    mediaTransport.getCurrentMediaSessionScope.mockReset();
    mediaTransport.getCurrentMediaSessionScope.mockReturnValue('anonymous');
    tauriApi.isTauri.mockReset();
    tauriApi.invoke.mockReset();
    tauriApi.invoke.mockResolvedValue(LOOPBACK_URL);
    tauriApi.convertFileSrc.mockReset();
    tauriApi.convertFileSrc.mockImplementation(
      (url: string, protocol: string) => `${protocol}://${url}`
    );
    imageProbes.length = 0;
    vi.stubGlobal('Image', StubImage);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rendered-media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        ready: Promise.resolve({}),
        addEventListener: vi.fn<(...args: unknown[]) => void>(),
        removeEventListener: vi.fn<(...args: unknown[]) => void>(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the original url when the service worker acks media-auth support', async () => {
    swMediaAuth.getCachedSWMediaAuthSupport.mockReturnValue(true);
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaUrl('https://example.org/media.png'));

    expect(result.current).toBe('https://example.org/media.png');
    expect(mediaTransport.fetchMediaBlob).not.toHaveBeenCalled();
  }, 20_000);

  it('rejects non-browser-safe media urls when media-auth support is confirmed', async () => {
    swMediaAuth.getCachedSWMediaAuthSupport.mockReturnValue(true);
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');
    const javascriptUrlValue = ['javascript', 'alert(1)'].join(':');

    const javascriptUrl = renderHook(() => useRenderableMediaUrl(javascriptUrlValue));
    const mxcUrl = renderHook(() => useRenderableMediaUrl('mxc://example.org/media-id'));
    const relativeUrl = renderHook(() => useRenderableMediaUrl('/relative/path.png'));

    expect(javascriptUrl.result.current).toBeUndefined();
    expect(mxcUrl.result.current).toBeUndefined();
    expect(relativeUrl.result.current).toBeUndefined();
    expect(mediaTransport.fetchMediaBlob).not.toHaveBeenCalled();
  });

  it('returns a blob url while media-auth support is unconfirmed', async () => {
    mediaTransport.fetchMediaBlob.mockResolvedValue(new Blob(['media'], { type: 'image/png' }));
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaUrl('https://example.org/media.png'));

    await waitFor(() => {
      expect(result.current).toBe('blob:rendered-media');
    });

    expect(mediaTransport.fetchMediaBlob).toHaveBeenCalledWith('https://example.org/media.png');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('does not fetch invalid media urls while media-auth support is unconfirmed', async () => {
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaUrl('data:text/html,boom'));

    expect(result.current).toBeUndefined();
    expect(mediaTransport.fetchMediaBlob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('returns existing blob urls unchanged while media-auth support is unconfirmed', async () => {
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() =>
      useRenderableMediaUrl('blob:http://localhost:8080/blob-id')
    );

    expect(result.current).toBe('blob:http://localhost:8080/blob-id');
    expect(mediaTransport.fetchMediaBlob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('uses the blob-backed path until the service worker acks media-auth support', async () => {
    mediaTransport.fetchMediaBlob.mockResolvedValue(new Blob(['media'], { type: 'image/png' }));
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaUrl('https://example.org/media.png'));

    await waitFor(() => {
      expect(result.current).toBe('blob:rendered-media');
    });

    expect(mediaTransport.fetchMediaBlob).toHaveBeenCalledWith('https://example.org/media.png');
  });

  it('refetches blob-backed media when the active session changes', async () => {
    mediaTransport.fetchMediaBlob
      .mockResolvedValueOnce(new Blob(['alice'], { type: 'image/png' }))
      .mockResolvedValueOnce(new Blob(['bob'], { type: 'image/png' }));
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce('blob:alice-media')
      .mockReturnValueOnce('blob:bob-media');

    const { activeSessionIdAtom } = await import('$state/sessions');
    const store = createStore();
    store.set(activeSessionIdAtom, '@alice:example.org');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaUrl('https://example.org/media.png'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current).toBe('blob:alice-media');
    });

    act(() => {
      store.set(activeSessionIdAtom, '@bob:example.org');
    });

    expect(result.current).toBeUndefined();

    await waitFor(() => {
      expect(result.current).toBe('blob:bob-media');
    });

    expect(mediaTransport.fetchMediaBlob).toHaveBeenNthCalledWith(
      1,
      'https://example.org/media.png'
    );
    expect(mediaTransport.fetchMediaBlob).toHaveBeenNthCalledWith(
      2,
      'https://example.org/media.png'
    );
  });

  it('retains the object url in LRU cache when consumers unmount and revokes on cache clear', async () => {
    mediaTransport.fetchMediaBlob.mockResolvedValue(new Blob(['media'], { type: 'image/png' }));
    const { useRenderableMediaUrl, clearRenderableMediaUrlCache } =
      await import('./useRenderableMediaUrl');

    const first = renderHook(() => useRenderableMediaUrl('https://example.org/media.png'));
    const second = renderHook(() => useRenderableMediaUrl('https://example.org/media.png'));

    await waitFor(() => {
      expect(first.result.current).toBe('blob:rendered-media');
      expect(second.result.current).toBe('blob:rendered-media');
    });

    first.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    second.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    clearRenderableMediaUrlCache();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:rendered-media');
  });

  it('rewrites raw authenticated-media https URLs under Tauri', async () => {
    tauriApi.isTauri.mockReturnValue(true);
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const rawAuthUrl =
      'https://matrix.example.org/_matrix/client/v1/media/thumbnail/example.org/abc123?width=96&height=96';
    const { result } = renderHook(() => useRenderableMediaUrl(rawAuthUrl));

    await waitFor(() => expect(result.current).toBe(LOOPBACK_URL));
    expect(tauriApi.invoke).toHaveBeenCalledWith('prepare_loopback_media', {
      url: `sable-media://${rawAuthUrl}&__sable_media_cache=3&__sable_media_session=anonymous`,
    });
    expect(tauriApi.convertFileSrc).toHaveBeenCalledWith(rawAuthUrl, 'sable-media');
  });

  it('passes through already-rewritten sable-media:// URLs under Tauri', async () => {
    tauriApi.isTauri.mockReturnValue(true);
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const rewrittenUrl =
      'sable-media://https://matrix.example.org/_matrix/client/v1/media/thumbnail/example.org/abc123';
    const { result } = renderHook(() => useRenderableMediaUrl(rewrittenUrl));

    await waitFor(() => expect(result.current).toBe(LOOPBACK_URL));
    expect(tauriApi.invoke).toHaveBeenCalledWith('prepare_loopback_media', {
      url: `${rewrittenUrl}?__sable_media_cache=3&__sable_media_session=anonymous`,
    });
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });

  it('drops the previous loopback url when the media source goes away under Tauri', async () => {
    tauriApi.isTauri.mockReturnValue(true);
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result, rerender } = renderHook(
      ({ url }: { url: string | undefined }) => useRenderableMediaUrl(url),
      { initialProps: { url: 'https://example.org/banner.png' as string | undefined } }
    );

    await waitFor(() => expect(result.current).toBe(LOOPBACK_URL));

    rerender({ url: undefined });

    expect(result.current).toBeUndefined();
  });

  it('passes through non-authenticated URLs unchanged under Tauri', async () => {
    tauriApi.isTauri.mockReturnValue(true);
    const { useRenderableMediaUrl } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaUrl('https://example.org/avatar.png'));

    await waitFor(() => expect(result.current).toBe(LOOPBACK_URL));
    expect(tauriApi.invoke).toHaveBeenCalledWith('prepare_loopback_media', {
      url: 'https://example.org/avatar.png',
    });
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });

  it('re-resolves the loopback url after the cache is cleared by a token rotation', async () => {
    tauriApi.isTauri.mockReturnValue(true);
    const freshLoopback = 'http://127.0.0.1:45678/capability-new-token';
    let resolveFresh: (url: string) => void = () => {};
    tauriApi.invoke
      .mockResolvedValueOnce('http://127.0.0.1:45678/capability-old-token')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFresh = resolve;
          })
      );
    const { useRenderableMediaUrl, clearLoopbackMediaUrlCache } =
      await import('./useRenderableMediaUrl');

    const rawUrl =
      'sable-media://https://matrix.example.org/_matrix/client/v1/media/thumbnail/example.org/abc123';
    const { result } = renderHook(() => useRenderableMediaUrl(rawUrl));

    await waitFor(() => expect(result.current).toBe('http://127.0.0.1:45678/capability-old-token'));

    // A rotated access token clears the loopback routes in Rust and the JS cache, so the
    // resolved URL is orphaned until it is re-resolved.
    act(() => {
      clearLoopbackMediaUrlCache();
    });

    await waitFor(() => expect(result.current).toBeUndefined());

    act(() => {
      resolveFresh(freshLoopback);
    });

    await waitFor(() => expect(result.current).toBe(freshLoopback));
    expect(tauriApi.invoke).toHaveBeenCalledTimes(2);
  });

  it('withholds the raw source under Tauri until the loopback url resolves', async () => {
    tauriApi.isTauri.mockReturnValue(true);
    let resolveLoopback: (url: string) => void = () => {};
    tauriApi.invoke.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLoopback = resolve;
      })
    );
    const { useRenderableMediaSource } = await import('./useRenderableMediaUrl');

    const rawUrl =
      'sable-media://https://matrix.example.org/_matrix/client/v1/media/thumbnail/example.org/abc123';
    const { result } = renderHook(() => useRenderableMediaSource(rawUrl));

    expect(result.current).toBeUndefined();

    await act(async () => {
      resolveLoopback(LOOPBACK_URL);
    });
    await waitFor(() => expect(result.current).toBe(LOOPBACK_URL));
  });

  it('falls back to the raw source outside Tauri while the blob resolves', async () => {
    tauriApi.isTauri.mockReturnValue(false);
    mediaTransport.fetchMediaBlob.mockReturnValue(new Promise<Blob>(() => {}));
    const { useRenderableMediaSource } = await import('./useRenderableMediaUrl');

    const { result } = renderHook(() => useRenderableMediaSource('https://example.org/avatar.png'));

    expect(result.current).toBe('https://example.org/avatar.png');
  });

  describe('useAvatarMediaSource', () => {
    const RAW_URL =
      'sable-media://https://matrix.example.org/_matrix/client/v1/media/thumbnail/example.org/abc123';

    it('retries with a fresh revision after the image fails to load', async () => {
      vi.useFakeTimers();
      tauriApi.isTauri.mockReturnValue(true);
      tauriApi.invoke
        .mockResolvedValueOnce('http://127.0.0.1:45678/stale-capability')
        .mockResolvedValueOnce('http://127.0.0.1:45678/fresh-capability');
      const { useAvatarMediaSource } = await import('./useRenderableMediaUrl');

      const { result } = renderHook(() => useAvatarMediaSource(RAW_URL));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.mediaSrc).toBe('http://127.0.0.1:45678/stale-capability');
      expect(result.current.error).toBe(false);

      act(() => {
        result.current.onError();
      });
      expect(result.current.error).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // The revision advances, but the latch stays shut so the caller keeps rendering its
      // fallback rather than blinking through an empty <img> for the duration of the load.
      expect(result.current.error).toBe(true);
      expect(result.current.mediaSrc).toBe('http://127.0.0.1:45678/fresh-capability');
      expect(tauriApi.invoke).toHaveBeenCalledTimes(2);
      const retryUrl = tauriApi.invoke.mock.calls[1]?.[1].url ?? '';
      expect(retryUrl).toContain('__sable_media_retry=1');

      const probe = imageProbes.at(-1);
      expect(probe?.src).toBe('http://127.0.0.1:45678/fresh-capability');

      act(() => {
        probe?.emit('load');
      });
      expect(result.current.error).toBe(false);
      vi.useRealTimers();
    });

    it('only reveals the image once the out-of-band retry decodes', async () => {
      vi.useFakeTimers();
      tauriApi.isTauri.mockReturnValue(true);
      tauriApi.invoke.mockImplementation(
        async (_cmd: string, args: { url: string }) =>
          `http://127.0.0.1:45678/capability-${args.url.length}`
      );
      const { useAvatarMediaSource } = await import('./useRenderableMediaUrl');

      const { result } = renderHook(() =>
        useAvatarMediaSource(RAW_URL, { crossOrigin: 'anonymous' })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.onError();
      });

      // Two attempts elapse without the preload ever settling: the latch never opens, so
      // the fallback is continuous instead of flashing once per attempt.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(result.current.error).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(result.current.error).toBe(true);

      // The preload must request exactly what the rendered element would, or it warms a
      // different cache entry and the real <img> refetches.
      const probe = imageProbes.at(-1);
      expect(probe?.src).toBe(result.current.mediaSrc);
      expect(probe?.crossOrigin).toBe('anonymous');
      vi.useRealTimers();
    });

    it('stops retrying once the backoff schedule is exhausted', async () => {
      vi.useFakeTimers();
      tauriApi.isTauri.mockReturnValue(true);
      tauriApi.invoke.mockImplementation(async (_cmd: string, args: { url: string }) => {
        return `http://127.0.0.1:45678/capability-${args.url.length}`;
      });
      const { useAvatarMediaSource } = await import('./useRenderableMediaUrl');

      const { result } = renderHook(() => useAvatarMediaSource(RAW_URL));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.mediaSrc).toBeDefined();

      act(() => {
        result.current.onError();
      });
      expect(result.current.error).toBe(true);

      // Nothing ever loads, so the latch holds and the ladder walks its whole schedule.
      const advance = async (delay: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        expect(result.current.error).toBe(true);
      };
      await advance(500);
      await advance(1500);
      await advance(4500);

      // One resolve for the initial source plus one per scheduled retry.
      expect(tauriApi.invoke).toHaveBeenCalledTimes(4);

      await advance(60_000);
      expect(tauriApi.invoke).toHaveBeenCalledTimes(4);
      vi.useRealTimers();
    });

    it('resets the retry budget when the source changes', async () => {
      vi.useFakeTimers();
      tauriApi.isTauri.mockReturnValue(true);
      tauriApi.invoke.mockResolvedValue('http://127.0.0.1:45678/capability');
      const { useAvatarMediaSource } = await import('./useRenderableMediaUrl');

      const { result, rerender } = renderHook(
        ({ url }: { url: string | undefined }) => useAvatarMediaSource(url),
        { initialProps: { url: RAW_URL as string | undefined } }
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        result.current.onError();
      });
      expect(result.current.error).toBe(true);

      rerender({ url: undefined });
      expect(result.current.error).toBe(false);
      expect(result.current.mediaSrc).toBeUndefined();
      vi.useRealTimers();
    });
  });
});
