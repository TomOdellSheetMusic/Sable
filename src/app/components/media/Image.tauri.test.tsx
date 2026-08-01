// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}));

import { tauriMediaObjectUrlTestHooks } from '$hooks/useTauriMediaObjectUrl';
import { Image } from './Image';

const THUMBNAIL_URL =
  'http://sable-media.localhost/https%3A%2F%2fexample.org%2F_matrix%2Fmedia%2Fv3%2Fthumbnail%2Fa%2Fb?__sable_media_cache=3';
const DOWNLOAD_URL =
  'http://sable-media.localhost/https%3A%2F%2fexample.org%2F_matrix%2Fmedia%2Fv3%2Fdownload%2Fa%2Fb?__sable_media_cache=3';

beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn<() => string>(() => {
      counter += 1;
      return `blob:mock-${counter}`;
    }),
    revokeObjectURL: vi.fn<() => void>(),
  });
  tauriMediaObjectUrlTestHooks.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response('image-bytes', { status: 200 }))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Image on Tauri', () => {
  it('serves thumbnails from the session blob cache, fetching once across remounts', async () => {
    const first = render(<Image src={THUMBNAIL_URL} alt="thumb" />);
    await waitFor(() =>
      expect(screen.getByAltText('thumb')).toHaveAttribute('src', 'blob:mock-1')
    );
    first.unmount();

    render(<Image src={THUMBNAIL_URL} alt="thumb-again" />);
    expect(screen.getByAltText('thumb-again')).toHaveAttribute('src', 'blob:mock-1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps full-size downloads on the native scheme path', () => {
    render(<Image src={DOWNLOAD_URL} alt="full" />);

    expect(screen.getByAltText('full')).toHaveAttribute('src', DOWNLOAD_URL);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('session-caches small picker downloads and skips files over the size gate', async () => {
    render(<Image src={DOWNLOAD_URL} alt="emote" sessionCache info={{ size: 20_000 }} />);
    await waitFor(() =>
      expect(screen.getByAltText('emote')).toHaveAttribute('src', 'blob:mock-1')
    );

    render(<Image src={DOWNLOAD_URL} alt="big" sessionCache info={{ size: 5_000_000 }} />);
    expect(screen.getByAltText('big')).toHaveAttribute('src', DOWNLOAD_URL);
  });
});
