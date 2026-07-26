import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from 'matrix-js-sdk/lib/models/typed-event-emitter';
import type { StoredNotification } from '$utils/localNotifications';
import {
  clearLocalNotificationCache,
  destroyLocalNotificationCache,
  getLocalNotificationCache,
} from '$client/localNotificationCache';
import { useLocalNotificationTimeline } from './useLocalNotificationTimeline';

const USER_ID = '@user:example.com';
const ROOM_ID = '!room:example.com';

const emitter = new TypedEventEmitter<string, Record<string, (...args: never[]) => void>>();
const mockClient = Object.assign(emitter, { getSafeUserId: () => USER_ID });

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => mockClient,
}));

vi.mock('$state/room-list/roomList', () => ({
  allRoomsAtom: { toString: () => 'allRoomsAtom' },
}));

vi.mock('jotai', () => ({
  useAtomValue: () => [ROOM_ID],
}));

const entry = (eventId: string, ts: number): StoredNotification => ({
  room_id: ROOM_ID,
  event: {
    event_id: eventId,
    type: 'm.room.message',
    content: { body: eventId, msgtype: 'm.text' },
    sender: '@other:example.com',
    origin_server_ts: ts,
    room_id: ROOM_ID,
    unsigned: {},
  },
  ts,
  highlight: true,
  isDM: false,
});

const seed = (count: number) => {
  const cache = getLocalNotificationCache(USER_ID);
  cache.mergeMany(Array.from({ length: count }, (_, i) => entry(`$e${i}`, 1000 + i)));
  return cache;
};

beforeEach(() => {
  localStorage.clear();
  emitter.removeAllListeners();
});

afterEach(() => {
  destroyLocalNotificationCache(USER_ID);
  clearLocalNotificationCache(USER_ID);
  localStorage.clear();
});

describe('useLocalNotificationTimeline render behaviour', () => {
  it('settles instead of re-rendering forever when the cache keeps changing', async () => {
    const cache = seed(60);
    let renders = 0;

    const { result } = renderHook(() => {
      renders += 1;
      return useLocalNotificationTimeline(24, 'all');
    });

    await act(async () => {
      await result.current[1]();
    });
    const afterFirstLoad = renders;

    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        cache.merge(entry(`$new${i}`, 5000 + i));
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(renders - afterFirstLoad).toBeLessThan(10);
  });

  it('does not rewind the loaded window when the cache changes', async () => {
    const cache = seed(60);

    const { result } = renderHook(() => useLocalNotificationTimeline(24, 'all'));

    await act(async () => {
      await result.current[1]();
    });
    const firstPage = result.current[0].groups[0]!.notifications.length;
    expect(result.current[0].nextToken).toBe('24');

    await act(async () => {
      await result.current[1](result.current[0].nextToken);
    });
    const secondPage = result.current[0].groups[0]!.notifications.length;
    expect(secondPage).toBeGreaterThan(firstPage);

    // A silent reload used to reset back to a single page.
    await act(async () => {
      cache.merge(entry('$live', 9000));
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    await waitFor(() =>
      expect(result.current[0].groups[0]!.notifications.length).toBeGreaterThanOrEqual(secondPage)
    );
  });

  it('keeps the same timeline object when nothing changed', async () => {
    const cache = seed(5);

    const { result } = renderHook(() => useLocalNotificationTimeline(24, 'all'));

    await act(async () => {
      await result.current[1]();
    });
    const before = result.current[0];

    await act(async () => {
      cache.mergeMany([entry('$e0', 1000)]);
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(result.current[0]).toBe(before);
  });
});
