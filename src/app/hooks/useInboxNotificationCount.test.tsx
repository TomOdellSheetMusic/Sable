import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from 'matrix-js-sdk/lib/models/typed-event-emitter';
import type { MatrixClient, Room } from '$types/matrix-sdk';
import { RoomEvent } from '$types/matrix-sdk';
import type { StoredNotification } from '$utils/localNotifications';
import {
  clearLocalNotificationCache,
  destroyLocalNotificationCache,
  getLocalNotificationCache,
} from '$client/localNotificationCache';
import { useInboxNotificationCount } from './useInboxNotificationCount';

const USER_ID = '@user:example.com';
const ROOM_ID = '!room:example.com';

type RoomBehaviour = {
  read?: boolean;
  known?: boolean;
  receiptTs?: number;
};

const createRoom = ({ read = false, known = true, receiptTs }: RoomBehaviour = {}): Room =>
  ({
    roomId: ROOM_ID,
    findEventById: (id: string) =>
      known && !id.startsWith('$receipt') ? { getTs: () => 1 } : undefined,
    hasUserReadEvent: () => read,
    getReadReceiptForUserId: () =>
      receiptTs === undefined ? null : { eventId: '$receipt', data: { ts: receiptTs } },
  }) as unknown as Room;

let currentRoom: Room | undefined = createRoom();

const emitter = new TypedEventEmitter<string, Record<string, (...args: never[]) => void>>();
const makeClient = () =>
  Object.assign(Object.create(Object.getPrototypeOf(emitter) as object), emitter, {
    getSafeUserId: () => USER_ID,
    getRoom: () => currentRoom,
  }) as unknown as MatrixClient;

let mockClient = makeClient();

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => mockClient,
}));

const entry = (
  eventId: string,
  overrides: Partial<StoredNotification> = {}
): StoredNotification => ({
  room_id: ROOM_ID,
  event: {
    event_id: eventId,
    type: 'm.room.message',
    content: { body: eventId, msgtype: 'm.text' },
    sender: '@other:example.com',
    origin_server_ts: 1000,
    room_id: ROOM_ID,
    unsigned: {},
  },
  ts: 1000,
  highlight: true,
  isDM: false,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  currentRoom = createRoom();
  emitter.removeAllListeners();
  mockClient = makeClient();
});

afterEach(() => {
  destroyLocalNotificationCache(USER_ID);
  clearLocalNotificationCache(USER_ID);
  localStorage.clear();
});

describe('useInboxNotificationCount', () => {
  it('counts an unread mention', async () => {
    getLocalNotificationCache(USER_ID).merge(entry('$a'));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('counts an unread DM even without a highlight', async () => {
    getLocalNotificationCache(USER_ID).merge(entry('$a', { highlight: false, isDM: true }));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('ignores an entry that is neither a highlight nor a DM', async () => {
    getLocalNotificationCache(USER_ID).merge(entry('$a', { highlight: false, isDM: false }));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(0));
  });

  it('ignores a dismissed entry', async () => {
    getLocalNotificationCache(USER_ID).merge(entry('$a', { dismissed: true }));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(0));
  });

  it('ignores an entry the user has already read', async () => {
    currentRoom = createRoom({ read: true });
    getLocalNotificationCache(USER_ID).merge(entry('$a'));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(0));
  });

  // Under sliding sync an entry outside the loaded window is routine; it must
  // still badge rather than being treated as read.
  it('counts an entry whose event is outside the loaded timeline', async () => {
    currentRoom = createRoom({ known: false });
    getLocalNotificationCache(USER_ID).merge(entry('$a'));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('stops counting once a receipt covers an aged-out entry', async () => {
    currentRoom = createRoom({ known: false, receiptTs: 5000 });
    getLocalNotificationCache(USER_ID).merge(entry('$a'));

    const { result } = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(result.current).toBe(0));
  });

  it('picks up a notification recorded after mount', async () => {
    const { result } = renderHook(() => useInboxNotificationCount());
    await waitFor(() => expect(result.current).toBe(0));

    await act(async () => {
      getLocalNotificationCache(USER_ID).merge(entry('$late'));
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    await waitFor(() => expect(result.current).toBe(1));
  });

  it('shares one subscription across consumers', async () => {
    getLocalNotificationCache(USER_ID).merge(entry('$a'));

    const first = renderHook(() => useInboxNotificationCount());
    const second = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(first.result.current).toBe(1));
    expect(second.result.current).toBe(1);
    expect(emitter.listenerCount(RoomEvent.Receipt)).toBe(1);

    first.unmount();
    expect(emitter.listenerCount(RoomEvent.Receipt)).toBe(1);

    const third = renderHook(() => useInboxNotificationCount());
    expect(emitter.listenerCount(RoomEvent.Receipt)).toBe(1);

    second.unmount();
    third.unmount();
  });

  it('rebuilds the store when the client is replaced', async () => {
    getLocalNotificationCache(USER_ID).merge(entry('$a'));

    const first = renderHook(() => useInboxNotificationCount());
    await waitFor(() => expect(first.result.current).toBe(1));
    first.unmount();

    mockClient = makeClient();
    const second = renderHook(() => useInboxNotificationCount());

    await waitFor(() => expect(second.result.current).toBe(1));
  });
});
