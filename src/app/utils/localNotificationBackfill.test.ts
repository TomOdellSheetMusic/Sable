import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { backfillLocalNotifications, scheduleLiveTimelineScan } from './localNotificationBackfill';
import {
  getLocalNotificationCache,
  clearLocalNotificationCache,
} from '$client/localNotificationCache';
import { MAX_BACKFILL_ROOMS } from './localNotifications';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID = '!active:example.com';
const USER_ID = '@test:example.com';

type RoomOverrides = Omit<Partial<Room>, 'isSpaceRoom'> & {
  lastActiveTs?: number;
  isSpaceRoom?: boolean;
  _events?: Partial<MatrixEvent>[];
};

const createRoom = (roomId: string, overrides: RoomOverrides = {}): Room => {
  const { lastActiveTs, isSpaceRoom, _events, ...rest } = overrides;
  return {
    roomId,
    getLastActiveTimestamp: () => lastActiveTs ?? Date.now(),
    isSpaceRoom: isSpaceRoom ? () => true : () => false,
    getJoinedMemberCount: () => 3, // not 2, so isDMRoom's heuristic doesn't fire
    getLiveTimeline: () => ({
      getEvents: () => (_events ?? []) as MatrixEvent[],
      // evaluateNotification reads m.room.encryption to decide whether the
      // encrypted-content setting applies.
      getState: () => ({ getStateEvents: () => undefined }),
    }),
    getAccountData: () => undefined,
    ...rest,
  } as unknown as Room;
};

const createEvent = (ts: number, id?: string): Partial<MatrixEvent> =>
  ({
    getId: () => id ?? `$ev_${ts}`,
    getTs: () => ts,
    getSender: () => '@other:example.com',
    getType: () => 'm.room.message',
    getContent: () => ({ body: 'hello', msgtype: 'm.text' }),
    isRedacted: () => false,
    isSending: () => false,
    getRelation: () => undefined,
  }) as unknown as Partial<MatrixEvent>;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearLocalNotificationCache(USER_ID);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillLocalNotifications', () => {
  it('no watermark (new device) → no backfill', async () => {
    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockResolvedValue(undefined as unknown as Room);

    const mx = {
      getRooms: () => [],
      getRoom: () => undefined,
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    const recorded = await backfillLocalNotifications(mx, USER_ID);

    expect(recorded).toBe(0);
    expect(scrollback).not.toHaveBeenCalled();
  });

  it('recent watermark (small gap) → no backfill', async () => {
    const now = Date.now();
    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(now - 1 * 60 * 1000); // 1 minute ago, below GAP_THRESHOLD_MS (5 min)

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockResolvedValue(undefined as unknown as Room);

    const mx = {
      getRooms: () => [],
      getRoom: () => undefined,
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    const recorded = await backfillLocalNotifications(mx, USER_ID, now);

    expect(recorded).toBe(0);
    expect(scrollback).not.toHaveBeenCalled();
  });

  it('stale watermark (large gap) → backfills active rooms', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    const activeEvents = [createEvent(now - 30 * 1000, '$active1')];
    const spaceEvents = [createEvent(now - 30 * 1000, '$space1')];

    const activeRoom = createRoom('!active:example.com', {
      lastActiveTs: now - 60 * 1000,
      _events: activeEvents,
    });
    const spaceRoom = createRoom('!space:example.com', {
      isSpaceRoom: true,
      lastActiveTs: now - 60 * 1000,
      _events: spaceEvents,
    });
    const mutedRoom = createRoom('!muted:example.com', {
      lastActiveTs: now - 60 * 1000,
      _events: [],
    });

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockImplementation(async (room: Room) => room as unknown as Room);

    const pushRulesForMuted = {
      global: {
        override: [{ rule_id: '!muted:example.com', enabled: true, actions: ['dont_notify'] }],
      },
    };
    const getAccountData = vi
      .fn<(type: unknown) => unknown>()
      .mockImplementation((eventType: unknown) => {
        if (eventType === 'm.direct') return { getContent: () => ({}) } as unknown;
        if (eventType === 'm.push_rules') {
          return { getContent: () => pushRulesForMuted } as unknown;
        }
        return undefined;
      });

    const mx = {
      getRooms: () => [activeRoom, spaceRoom, mutedRoom],
      getRoom: (roomId: string) => {
        if (roomId === '!active:example.com') return activeRoom;
        if (roomId === '!space:example.com') return spaceRoom;
        if (roomId === '!muted:example.com') return mutedRoom;
        return undefined;
      },
      scrollback,
      getAccountData,
      getRoomPushRule: (_scope: string, roomId: string) => {
        if (roomId === '!muted:example.com') throw new Error('no rule');
        throw new Error('no rule');
      },
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    const recorded = await backfillLocalNotifications(mx, USER_ID, now);

    expect(recorded).toBeGreaterThanOrEqual(0);
    // Only the active (non-space, non-muted) room should be scrolled
    const scrollbackRoomIds = scrollback.mock.calls.map((call) => (call[0] as Room).roomId);
    expect(scrollbackRoomIds).toContain('!active:example.com');
    expect(scrollbackRoomIds).not.toContain('!space:example.com');
    expect(scrollbackRoomIds).not.toContain('!muted:example.com');
  });

  it('respects MAX_BACKFILL_ROOMS = 30', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockResolvedValue(undefined as unknown as Room);

    const rooms: Room[] = Array.from({ length: 40 }, (_, i) =>
      createRoom(`!room${i}:example.com`, {
        lastActiveTs: now - 60 * 1000 + i * 1000, // each slightly more recent
        _events: [],
      })
    );

    const mx = {
      getRooms: () => rooms,
      getRoom: (roomId: string) => rooms.find((r) => r.roomId === roomId),
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getRoomPushRule: () => {
        throw new Error('no rule');
      },
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    await backfillLocalNotifications(mx, USER_ID, now);

    // (30 rooms × up to 2 pages = up to 60 calls, but unique rooms ≤ 30.)
    const scrollbackRoomIds = scrollback.mock.calls.map((call) => (call[0] as Room).roomId);
    const uniqueRooms = new Set(scrollbackRoomIds);
    expect(uniqueRooms.size).toBeLessThanOrEqual(MAX_BACKFILL_ROOMS);
  });

  it('early stop: events older than watermark → only 1 page', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    const events = [
      createEvent(now - 10 * 1000, '$recent'),
      createEvent(now - 60 * 1000, '$mid'),
      createEvent(twoHoursAgo - 10 * 1000, '$old'), // older than watermark
    ];

    const room = createRoom(ROOM_ID, {
      lastActiveTs: now - 60 * 1000,
      _events: events,
    });

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockImplementation(async (r: Room) => r as unknown as Room);

    const mx = {
      getRooms: () => [room],
      getRoom: () => room,
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getRoomPushRule: () => {
        throw new Error('no rule');
      },
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    await backfillLocalNotifications(mx, USER_ID, now);

    expect(scrollback).toHaveBeenCalledTimes(1);
  });

  it('adaptive pages: small gap → 1 page, large gap → up to 2 pages', async () => {
    const now = Date.now();
    const smallGapMs = 10 * 60 * 1000; // 10 minutes (< 30 min)
    const largeGapMs = 2 * 60 * 60 * 1000; // 2 hours (> 30 min)

    {
      const uid = `${USER_ID}_small`;
      clearLocalNotificationCache(uid);
      const cache = getLocalNotificationCache(uid);
      cache.updateLastSeenTs(now - smallGapMs);

      const events = [createEvent(now - 5 * 1000, '$recent')];
      const room = createRoom('!small:example.com', {
        lastActiveTs: now - 5 * 1000,
        _events: events,
      });

      const scrollback = vi
        .fn<MatrixClient['scrollback']>()
        .mockImplementation(async (r: Room) => r as unknown as Room);

      const mx = {
        getRooms: () => [room],
        getRoom: () => room,
        scrollback,
        getAccountData: (type: unknown) =>
          type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
        getRoomPushRule: () => {
          throw new Error('no rule');
        },
        getSafeUserId: () => USER_ID,
        pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
        getUserId: () => USER_ID,
        pushProcessor: {
          actionsForEvent: vi
            .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
            .mockReturnValue({ notify: true, tweaks: {} }),
        },
      } as unknown as MatrixClient;

      await backfillLocalNotifications(mx, uid, now);
      expect(scrollback).toHaveBeenCalledTimes(1);
      clearLocalNotificationCache(uid);
    }

    {
      const uid = `${USER_ID}_large`;
      clearLocalNotificationCache(uid);
      const cache = getLocalNotificationCache(uid);
      cache.updateLastSeenTs(now - largeGapMs);

      const events = [createEvent(now - 5 * 1000, '$recent')];
      const room = createRoom('!large:example.com', {
        lastActiveTs: now - 5 * 1000,
        _events: events,
      });

      const scrollback = vi
        .fn<MatrixClient['scrollback']>()
        .mockImplementation(async (r: Room) => r as unknown as Room);

      const mx = {
        getRooms: () => [room],
        getRoom: () => room,
        scrollback,
        getAccountData: (type: unknown) =>
          type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
        getRoomPushRule: () => {
          throw new Error('no rule');
        },
        getSafeUserId: () => USER_ID,
        pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
        getUserId: () => USER_ID,
        pushProcessor: {
          actionsForEvent: vi
            .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
            .mockReturnValue({ notify: true, tweaks: {} }),
        },
      } as unknown as MatrixClient;

      await backfillLocalNotifications(mx, uid, now);
      expect(scrollback).toHaveBeenCalledTimes(2);
      clearLocalNotificationCache(uid);
    }
  });

  it('muted room skipped', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    const mutedRoom = createRoom('!muted:example.com', {
      lastActiveTs: now - 60 * 1000,
      _events: [],
    });

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockResolvedValue(undefined as unknown as Room);

    // getAccountData: return undefined for m.direct, return a mute override for m.push_rules
    let callCount = 0;
    const getAccountData = vi.fn<(type: unknown) => unknown>().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return undefined; // EventType.Direct
      return {
        getContent: () => ({
          global: {
            override: [{ rule_id: '!muted:example.com', actions: ['dont_notify'] }],
          },
        }),
      };
    });

    const mx = {
      getRooms: () => [mutedRoom],
      getRoom: () => mutedRoom,
      scrollback,
      getAccountData,
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    await backfillLocalNotifications(mx, USER_ID, now);

    expect(scrollback).not.toHaveBeenCalled();
  });

  it('sequential, not parallel: only one scrollback in-flight at a time', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    let inFlight = 0;
    let maxInFlight = 0;

    const rooms: Room[] = ['!r1:example.com', '!r2:example.com', '!r3:example.com'].map((id) =>
      createRoom(id, {
        lastActiveTs: now - 60 * 1000,
        _events: [createEvent(now - 5 * 1000)],
      })
    );

    const scrollback = vi.fn<MatrixClient['scrollback']>().mockImplementation(async (r: Room) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return r as unknown as Room;
    });

    const mx = {
      getRooms: () => rooms,
      getRoom: (roomId: string) => rooms.find((r) => r.roomId === roomId),
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getRoomPushRule: () => {
        throw new Error('no rule');
      },
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    await backfillLocalNotifications(mx, USER_ID, now);

    expect(maxInFlight).toBe(1);
  });

  it('returns count of recorded notifications', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    const events = [
      createEvent(now - 10 * 1000, '$a'),
      createEvent(now - 20 * 1000, '$b'),
      createEvent(now - 30 * 1000, '$c'),
    ];

    const room = createRoom(ROOM_ID, {
      lastActiveTs: now - 5 * 1000,
      _events: events,
    });

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockImplementation(async (r: Room) => r as unknown as Room);

    const mx = {
      getRooms: () => [room],
      getRoom: () => room,
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getRoomPushRule: () => {
        throw new Error('no rule');
      },
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    const recorded = await backfillLocalNotifications(mx, USER_ID, now);

    expect(recorded).toBe(3);
  });

  it('records events newer than the watermark when the page also contains older ones', async () => {
    // must not stop the page being recorded.
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const cache = getLocalNotificationCache(USER_ID);
    cache.updateLastSeenTs(twoHoursAgo);

    const events = [
      createEvent(twoHoursAgo - 10 * 1000, '$old'), // older than watermark
      createEvent(now - 30 * 1000, '$recent'), // newer than watermark
    ];

    const room = createRoom(ROOM_ID, {
      lastActiveTs: now - 5 * 1000,
      _events: events,
    });

    const scrollback = vi
      .fn<MatrixClient['scrollback']>()
      .mockImplementation(async (r: Room) => r as unknown as Room);

    const mx = {
      getRooms: () => [room],
      getRoom: () => room,
      scrollback,
      getAccountData: (type: unknown) =>
        type === 'm.direct' ? ({ getContent: () => ({}) } as unknown) : undefined,
      getRoomPushRule: () => {
        throw new Error('no rule');
      },
      getSafeUserId: () => USER_ID,
      pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
      getUserId: () => USER_ID,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: {} }),
      },
    } as unknown as MatrixClient;

    const recorded = await backfillLocalNotifications(mx, USER_ID, now);

    expect(recorded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordLiveTimelines — recovers what was dropped before push rules synced
// ---------------------------------------------------------------------------

describe('scheduleLiveTimelineScan', () => {
  const CONTENT = { storeContent: true, storeEncryptedContent: true };

  const clientWith = (rooms: Room[], withPushRules = true): MatrixClient =>
    ({
      getRooms: () => rooms,
      getRoom: (roomId: string) => rooms.find((r) => r.roomId === roomId),
      getSafeUserId: () => USER_ID,
      getUserId: () => USER_ID,
      pushRules: withPushRules
        ? { global: { override: [], content: [], room: [], sender: [], underride: [] } }
        : undefined,
      getAccountData: () => undefined,
      getRoomPushRule: () => undefined,
      pushProcessor: {
        actionsForEvent: vi
          .fn<() => { notify: boolean; tweaks: Record<string, unknown> }>()
          .mockReturnValue({ notify: true, tweaks: { highlight: true } }),
      },
    }) as unknown as MatrixClient;

  it('records events already sitting in the live timeline', async () => {
    const room = createRoom(ROOM_ID, {
      _events: [createEvent(1000, '$a'), createEvent(2000, '$b')],
    });

    const recorded = await scheduleLiveTimelineScan(
      clientWith([room]),
      USER_ID,
      new Set(),
      CONTENT
    );

    expect(recorded).toBe(2);
    expect(getLocalNotificationCache(USER_ID).getEntries()).toHaveLength(2);
  });

  it('is idempotent, so a rescan cannot duplicate entries', async () => {
    const room = createRoom(ROOM_ID, { _events: [createEvent(1000, '$a')] });
    const mx = clientWith([room]);

    await scheduleLiveTimelineScan(mx, USER_ID, new Set(), CONTENT);
    await scheduleLiveTimelineScan(mx, USER_ID, new Set(), CONTENT);

    expect(getLocalNotificationCache(USER_ID).getEntries()).toHaveLength(1);
  });

  it('preserves a dismissal across a rescan', async () => {
    const room = createRoom(ROOM_ID, { _events: [createEvent(1000, '$a')] });
    const mx = clientWith([room]);
    const cache = getLocalNotificationCache(USER_ID);

    await scheduleLiveTimelineScan(mx, USER_ID, new Set(), CONTENT);
    cache.dismiss('$a');
    await scheduleLiveTimelineScan(mx, USER_ID, new Set(), CONTENT);

    expect(cache.getEntries()[0]!.dismissed).toBe(true);
  });

  it('records nothing while push rules are still missing', async () => {
    const room = createRoom(ROOM_ID, { _events: [createEvent(1000, '$a')] });

    const recorded = await scheduleLiveTimelineScan(
      clientWith([room], false),
      USER_ID,
      new Set(),
      CONTENT
    );

    expect(recorded).toBe(0);
  });

  it('skips space rooms', async () => {
    const space = createRoom('!space:example.com', {
      isSpaceRoom: true,
      _events: [createEvent(1000, '$a')],
    });

    expect(await scheduleLiveTimelineScan(clientWith([space]), USER_ID, new Set(), CONTENT)).toBe(
      0
    );
  });

  it('omits the body when content must not be persisted', async () => {
    const room = createRoom(ROOM_ID, { _events: [createEvent(1000, '$a')] });

    await scheduleLiveTimelineScan(clientWith([room]), USER_ID, new Set(), {
      storeContent: false,
      storeEncryptedContent: false,
    });

    const entry = getLocalNotificationCache(USER_ID).getEntries()[0]!;
    expect(entry.event.content.body).toBeUndefined();
    expect(entry.event.content.msgtype).toBe('m.text');
  });
});
