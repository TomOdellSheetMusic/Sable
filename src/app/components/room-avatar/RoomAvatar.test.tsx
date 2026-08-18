import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
  useRenderableMediaSource: vi.fn<(url: string | undefined) => string | undefined>(),
}));

vi.mock('$hooks/useRenderableMediaUrl', () => media);

const RAW_SRC = 'https://example.org/_matrix/client/v1/media/thumbnail/example.org/avatar';

describe('RoomAvatar', () => {
  beforeEach(() => {
    vi.resetModules();
    media.useRenderableMediaSource.mockReset();
  });

  it('waits for a renderable url instead of requesting the raw one', async () => {
    media.useRenderableMediaSource.mockReturnValue(undefined);
    const { RoomAvatar } = await import('./RoomAvatar');

    const { rerender } = render(
      <RoomAvatar roomId="!room:example.org" src={RAW_SRC} renderFallback={() => 'RM'} />
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    media.useRenderableMediaSource.mockReturnValue('blob:resolved-avatar');
    rerender(<RoomAvatar roomId="!room:example.org" src={RAW_SRC} renderFallback={() => 'RM'} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:resolved-avatar');
  });

  it('falls back until a new url arrives when the image fails to load', async () => {
    media.useRenderableMediaSource.mockReturnValue('blob:resolved-avatar');
    const { RoomAvatar } = await import('./RoomAvatar');

    const { rerender } = render(
      <RoomAvatar roomId="!room:example.org" src={RAW_SRC} renderFallback={() => 'RM'} />
    );

    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    media.useRenderableMediaSource.mockReturnValue('blob:next-avatar');
    rerender(<RoomAvatar roomId="!room:example.org" src={RAW_SRC} renderFallback={() => 'RM'} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:next-avatar');
  });
});
