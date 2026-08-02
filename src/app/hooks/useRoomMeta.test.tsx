import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EventEmitter } from 'events';
import type { PropsWithChildren } from 'react';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { RoomStateEvent } from '$types/matrix-sdk';
import { MatrixClientProvider } from './useMatrixClient';
import { useRoomAvatar } from './useRoomMeta';

const AVATAR_MXC = 'mxc://server/abc';

const makeAvatarEvent = (roomId: string, url: string): MatrixEvent =>
  ({
    getRoomId: () => roomId,
    getType: () => 'm.room.avatar',
    getStateKey: () => '',
    getContent: () => ({ url }),
  }) as unknown as MatrixEvent;

const makeRoom = (roomId: string) => {
  const client = new EventEmitter();
  let avatarEvent: MatrixEvent | undefined;
  const room = {
    roomId,
    client,
    getLiveTimeline: () => ({
      getState: () => ({ getStateEvents: () => avatarEvent }),
    }),
  } as unknown as Room;
  return {
    room,
    client,
    wrapper: ({ children }: PropsWithChildren) => (
      <MatrixClientProvider value={client as unknown as MatrixClient}>
        {children}
      </MatrixClientProvider>
    ),
    setAvatarEvent: (event: MatrixEvent) => {
      avatarEvent = event;
    },
  };
};

describe('useRoomAvatar', () => {
  it('returns undefined when no avatar state is loaded', () => {
    const { room, wrapper } = makeRoom('!space:server');
    const { result } = renderHook(() => useRoomAvatar(room), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('updates when the avatar state event arrives after mount', () => {
    const { room, client, setAvatarEvent, wrapper } = makeRoom('!space:server');
    const { result } = renderHook(() => useRoomAvatar(room), { wrapper });
    expect(result.current).toBeUndefined();

    const avatarEvent = makeAvatarEvent('!space:server', AVATAR_MXC);
    setAvatarEvent(avatarEvent);
    act(() => {
      client.emit(RoomStateEvent.Events, avatarEvent);
    });

    expect(result.current).toBe(AVATAR_MXC);
  });

  it('ignores avatar state events from other rooms', () => {
    const { room, client, wrapper } = makeRoom('!space:server');
    const { result } = renderHook(() => useRoomAvatar(room), { wrapper });

    act(() => {
      client.emit(RoomStateEvent.Events, makeAvatarEvent('!other:server', AVATAR_MXC));
    });

    expect(result.current).toBeUndefined();
  });
});
