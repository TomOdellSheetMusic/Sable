import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import type { PushProcessor } from '$types/matrix-sdk';
import { EventType } from '$types/matrix-sdk';
import { NotificationType } from '$types/matrix/room';
import {
  MAX_BODY_LENGTH,
  arePushRulesReady,
  evaluateNotification,
  isStoredNotificationRead,
  sliceNotificationPage,
} from './localNotifications';
import type { StoredNotification } from './localNotifications';

const ROOM_ID = '!test:example.com';
const USER_ID = '@user:example.com';
const OTHER_USER = '@other:example.com';
const EVENT_ID = '$event1';

// ---------------------------------------------------------------------------
// Mock helpers — follow the hand-rolled pattern from room.unread.test.ts
// ---------------------------------------------------------------------------

const createEvent = (overrides: Partial<MatrixEvent> = {}): MatrixEvent =>
  ({
    getId: () => EVENT_ID,
    getSender: () => OTHER_USER,
    getType: () => 'm.room.message',
    getContent: (() => ({ body: 'Hello', msgtype: 'm.text' })) as MatrixEvent['getContent'],
    isRedacted: () => false,
    getRelation: () => undefined,
    isSending: () => false,
    getTs: () => 1000,
    ...overrides,
  }) as unknown as MatrixEvent;

const createRoom = (overrides: Partial<Room> = {}, encrypted = false): Room =>
  ({
    roomId: ROOM_ID,
    isSpaceRoom: () => false,
    getJoinedMemberCount: () => 3, // not 2, so isDMRoom's heuristic doesn't fire by default
    getLiveTimeline: () => ({
      getState: () => ({
        getStateEvents: (type: string) =>
          encrypted && type === EventType.RoomEncryption ? ({} as MatrixEvent) : undefined,
      }),
    }),
    ...overrides,
  }) as unknown as Room;

const createClient = (
  rooms: Record<string, Room> = {},
  pushActionsOverride: ReturnType<PushProcessor['actionsForEvent']> = { notify: true, tweaks: {} },
  getAccountDataFn?: MatrixClient['getAccountData'],
  getSafeUserIdFn?: MatrixClient['getSafeUserId']
): MatrixClient =>
  ({
    getUserId: () => USER_ID,
    getSafeUserId: getSafeUserIdFn ?? (() => USER_ID),
    // evaluateNotification refuses to classify until push rules have synced.
    pushRules: { global: { override: [], content: [], room: [], sender: [], underride: [] } },
    getRoom: (roomId: string) => rooms[roomId],
    pushProcessor: {
      actionsForEvent: vi
        .fn<PushProcessor['actionsForEvent']>()
        .mockReturnValue(pushActionsOverride),
    } as unknown as PushProcessor,
    getAccountData: getAccountDataFn ?? (() => undefined),
    getRoomPushRule: () => {
      throw new Error('no rule');
    },
  }) as unknown as MatrixClient;

// ---------------------------------------------------------------------------
// evaluateNotification exclusions
// ---------------------------------------------------------------------------

describe('arePushRulesReady', () => {
  it('is false before push rules have synced', () => {
    const mx = { pushRules: undefined } as unknown as MatrixClient;

    expect(arePushRulesReady(mx)).toBe(false);
  });

  it('is false when the ruleset has no global scope', () => {
    const mx = { pushRules: {} } as unknown as MatrixClient;

    expect(arePushRulesReady(mx)).toBe(false);
  });

  it('is true once a global ruleset is present', () => {
    expect(arePushRulesReady(createClient())).toBe(true);
  });
});

describe('evaluateNotification without push rules', () => {
  // actionsForEvent yields {} before rules sync, so notify is undefined and a
  // would-be mention looks identical to "do not notify".
  const clientWithoutRules = (room: Room): MatrixClient =>
    ({
      ...(createClient({ [ROOM_ID]: room }) as unknown as Record<string, unknown>),
      pushRules: undefined,
    }) as unknown as MatrixClient;

  it('declines to classify rather than deciding not to notify', () => {
    const room = createRoom();
    const mx = clientWithoutRules(room);
    const event = createEvent();

    expect(
      evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages)
    ).toBeUndefined();
  });

  it('declines even for an event the DM override would otherwise notify on', () => {
    const room = createRoom();
    const mx = clientWithoutRules(room);
    const event = createEvent();

    const result = evaluateNotification(
      mx,
      room,
      event,
      new Set([ROOM_ID]),
      NotificationType.AllMessages
    );

    expect(result).toBeUndefined();
  });

  it('records the same event once rules are present', () => {
    const room = createRoom();
    const event = createEvent();

    expect(
      evaluateNotification(
        createClient({ [ROOM_ID]: room }),
        room,
        event,
        new Set(),
        NotificationType.AllMessages
      )
    ).toBeDefined();
  });
});

describe('evaluateNotification exclusions', () => {
  it('returns undefined for muted room', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent();

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.Mute);

    expect(result).toBeUndefined();
  });

  it('returns undefined for space room', () => {
    const room = createRoom({ isSpaceRoom: () => true });
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent();

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeUndefined();
  });

  it('returns undefined for self-sender event', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({ getSender: () => USER_ID });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeUndefined();
  });

  it('returns undefined for m.room.member event', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({ getType: () => 'm.room.member' });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeUndefined();
  });

  it('returns undefined for redacted event', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({ isRedacted: () => true });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeUndefined();
  });

  it('returns undefined for m.replace edit event', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({
      getRelation: () => ({ rel_type: 'm.replace', event_id: '$orig' }),
    });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeUndefined();
  });

  it('returns undefined when isSending() is true', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({ isSending: () => true });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// evaluateNotification inclusions
// ---------------------------------------------------------------------------

describe('evaluateNotification inclusions', () => {
  it('returns StoredNotification for normal message with notify=true', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent();

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeDefined();
    expect(result!.room_id).toBe(ROOM_ID);
    expect(result!.event.event_id).toBe(EVENT_ID);
    expect(result!.event.type).toBe('m.room.message');
    expect(result!.event.content.body).toBe('Hello');
    expect(result!.highlight).toBe(false);
  });

  it('returns StoredNotification with highlight=true when tweaks.highlight is set', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room }, { notify: true, tweaks: { highlight: true } });
    const event = createEvent();

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeDefined();
    expect(result!.highlight).toBe(true);
  });

  it('DM force-override: notify=false but isDM + not MentionsAndKeywords → returns snapshot', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room }, { notify: false, tweaks: {} });
    const event = createEvent();
    const mDirects = new Set([ROOM_ID]);

    const result = evaluateNotification(mx, room, event, mDirects, NotificationType.AllMessages);

    expect(result).toBeDefined();
    expect(result!.room_id).toBe(ROOM_ID);
  });

  it('DM force-override: notify=false, isDM, but MentionsAndKeywords → returns undefined (override does NOT apply)', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room }, { notify: false, tweaks: {} });
    const event = createEvent();
    const mDirects = new Set([ROOM_ID]);

    const result = evaluateNotification(
      mx,
      room,
      event,
      mDirects,
      NotificationType.MentionsAndKeywords
    );

    expect(result).toBeUndefined();
  });

  it('truncates body to MAX_BODY_LENGTH', () => {
    const longBody = 'x'.repeat(1000);
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({
      getContent: (() => ({ body: longBody, msgtype: 'm.text' })) as MatrixEvent['getContent'],
    });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result).toBeDefined();
    expect(result!.event.content.body).toBe(`${longBody.slice(0, MAX_BODY_LENGTH)}…`);
    expect(result!.event.content.msgtype).toBe('m.text');
  });

  it('drops html when the message is too long, so the preview matches what is stored', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({
      getContent: (() => ({
        body: 'x'.repeat(1000),
        formatted_body: `<b>${'x'.repeat(1000)}</b>`,
        format: 'org.matrix.custom.html',
        msgtype: 'm.text',
      })) as MatrixEvent['getContent'],
    });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result!.event.content.formatted_body).toBeUndefined();
    expect(result!.event.content.format).toBeUndefined();
    expect(result!.event.content.body).toHaveLength(MAX_BODY_LENGTH + 1);
  });

  it('keeps html for short messages', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({
      getContent: (() => ({
        body: 'hi',
        formatted_body: '<b>hi</b>',
        format: 'org.matrix.custom.html',
        msgtype: 'm.text',
      })) as MatrixEvent['getContent'],
    });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result!.event.content.formatted_body).toBe('<b>hi</b>');
    expect(result!.event.content.body).toBe('hi');
  });

  it('drops oversized html even when the plain body is short', () => {
    const room = createRoom();
    const mx = createClient({ [ROOM_ID]: room });
    const event = createEvent({
      getContent: (() => ({
        body: 'short',
        formatted_body: `<b>${'x'.repeat(1000)}</b>`,
        format: 'org.matrix.custom.html',
        msgtype: 'm.text',
      })) as MatrixEvent['getContent'],
    });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result!.event.content.formatted_body).toBeUndefined();
    expect(result!.event.content.body).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// sliceNotificationPage
// ---------------------------------------------------------------------------

describe('sliceNotificationPage', () => {
  const makeItem = (
    ts: number,
    highlight = false,
    extra: Partial<StoredNotification> = {}
  ): StoredNotification =>
    ({
      room_id: ROOM_ID,
      event: {
        event_id: `$e${ts}`,
        type: 'm.room.message',
        content: {},
        sender: OTHER_USER,
        origin_server_ts: ts,
        room_id: ROOM_ID,
        unsigned: {},
      },
      ts,
      highlight,
      ...extra,
    }) as StoredNotification;

  it('first page: 30 items, offset=0, limit=24 → 24 items, nextToken="24"', () => {
    const all = Array.from({ length: 30 }, (_, i) => makeItem(3000 - i));

    const { page, nextToken } = sliceNotificationPage(all, 0, 24, 'all');

    expect(page).toHaveLength(24);
    expect(nextToken).toBe('24');
  });

  it('second page: offset=24, limit=24 → 6 items, nextToken=undefined', () => {
    const all = Array.from({ length: 30 }, (_, i) => makeItem(3000 - i));

    const { page, nextToken } = sliceNotificationPage(all, 24, 24, 'all');

    expect(page).toHaveLength(6);
    expect(nextToken).toBeUndefined();
  });

  it('last partial page: 50 items, offset=48, limit=24 → 2 items, nextToken=undefined', () => {
    const all = Array.from({ length: 50 }, (_, i) => makeItem(5000 - i));

    const { page, nextToken } = sliceNotificationPage(all, 48, 24, 'all');

    expect(page).toHaveLength(2);
    expect(nextToken).toBeUndefined();
  });

  it('onlyHighlight=true filters non-highlight items', () => {
    const all = [
      makeItem(5, false),
      makeItem(4, true),
      makeItem(3, false),
      makeItem(2, true),
      makeItem(1, false),
    ];

    const { page } = sliceNotificationPage(all, 0, 5, 'mentions');

    expect(page).toHaveLength(2);
    expect(page.every((n) => n.highlight)).toBe(true);
  });

  it("'mentions' keeps DMs that are not highlights", () => {
    // The default filter is highlights *and* DMs; a plain DM message has no
    // highlight tweak and must still appear.
    const all = [
      makeItem(3, false, { isDM: true }),
      makeItem(2, true),
      makeItem(1, false, { isDM: false }),
    ];

    const { page } = sliceNotificationPage(all, 0, 5, 'mentions');

    expect(page.map((n) => n.ts)).toEqual([3, 2]);
  });

  it('hides dismissed entries unless includeDone is set', () => {
    const all = [makeItem(2, true, { dismissed: true }), makeItem(1, true)];

    expect(sliceNotificationPage(all, 0, 5, 'mentions').page.map((n) => n.ts)).toEqual([1]);
    expect(sliceNotificationPage(all, 0, 5, 'mentions', true).page.map((n) => n.ts)).toEqual([
      2, 1,
    ]);
  });

  it('returns items newest-first (sorted by ts descending)', () => {
    const all = [makeItem(10), makeItem(5), makeItem(20), makeItem(15)];

    const { page } = sliceNotificationPage(all, 0, 4, 'all');

    expect(page.map((n) => n.ts)).toEqual([20, 15, 10, 5]);
  });
});

// ---------------------------------------------------------------------------
// isStoredNotificationRead
// ---------------------------------------------------------------------------

describe('isStoredNotificationRead', () => {
  const entry = (ts = 1000): StoredNotification =>
    ({ room_id: ROOM_ID, event: { event_id: EVENT_ID }, ts }) as StoredNotification;

  const readStateRoom = (overrides: Partial<Room>): Room =>
    createRoom({
      findEventById: () => undefined,
      getEventReadUpTo: () => null,
      getReadReceiptForUserId: () => null,
      hasUserReadEvent: () => false,
      ...overrides,
    } as Partial<Room>);

  it('defers to hasUserReadEvent while the event is in the timeline', () => {
    const room = readStateRoom({
      findEventById: ((id: string) =>
        id === EVENT_ID ? createEvent() : undefined) as Room['findEventById'],
      hasUserReadEvent: (() => true) as Room['hasUserReadEvent'],
    });

    expect(isStoredNotificationRead(room, USER_ID, entry())).toBe(true);
  });

  it('reports unread while the event is in the timeline and unread', () => {
    const room = readStateRoom({
      findEventById: (() => createEvent()) as Room['findEventById'],
      hasUserReadEvent: (() => false) as Room['hasUserReadEvent'],
    });

    expect(isStoredNotificationRead(room, USER_ID, entry())).toBe(false);
  });

  it('falls back to the receipt timestamp once the event has aged out', () => {
    const room = readStateRoom({
      getReadReceiptForUserId: (() => ({
        eventId: '$readUpTo',
        data: { ts: 5000 },
      })) as unknown as Room['getReadReceiptForUserId'],
    });

    expect(isStoredNotificationRead(room, USER_ID, entry(1000))).toBe(true);
    expect(isStoredNotificationRead(room, USER_ID, entry(9000))).toBe(false);
  });

  // Under sliding sync an entry outside the loaded window is the normal case,
  // so it must not be hidden just because nothing resolves.
  it('treats an unresolvable entry as unread', () => {
    const room = readStateRoom({});

    expect(isStoredNotificationRead(room, USER_ID, entry())).toBe(false);
  });

  it('honours a private receipt from a manual mark-as-read', () => {
    const room = readStateRoom({
      getReadReceiptForUserId: ((_userId: string, _ignore?: boolean, type?: string) =>
        type === 'm.read.private'
          ? { eventId: '$private', data: { ts: 5000 } }
          : null) as unknown as Room['getReadReceiptForUserId'],
    });

    expect(isStoredNotificationRead(room, USER_ID, entry(1000))).toBe(true);
    expect(isStoredNotificationRead(room, USER_ID, entry(9000))).toBe(false);
  });

  it('takes the newest of the public and private receipts', () => {
    const room = readStateRoom({
      getReadReceiptForUserId: ((_userId: string, _ignore?: boolean, type?: string) =>
        type === 'm.read.private'
          ? { eventId: '$private', data: { ts: 8000 } }
          : {
              eventId: '$public',
              data: { ts: 2000 },
            }) as unknown as Room['getReadReceiptForUserId'],
    });

    expect(isStoredNotificationRead(room, USER_ID, entry(5000))).toBe(true);
  });

  it('honours a mark-as-read while the event is still loaded', () => {
    const room = readStateRoom({
      findEventById: (() => createEvent()) as Room['findEventById'],
      hasUserReadEvent: (() => true) as Room['hasUserReadEvent'],
      getReadReceiptForUserId: (() => null) as unknown as Room['getReadReceiptForUserId'],
    });

    expect(isStoredNotificationRead(room, USER_ID, entry())).toBe(true);
  });
});

describe('evaluateNotification storage footprint', () => {
  const encryptedEvent = (content: Record<string, unknown>) =>
    createEvent({
      getType: () => 'm.room.encrypted',
      getContent: (() => content) as MatrixEvent['getContent'],
    });

  it('drops megolm ciphertext and keeps only the algorithm', () => {
    const room = createRoom({}, true);
    const mx = createClient({ [ROOM_ID]: room });
    const event = encryptedEvent({
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'A'.repeat(4096),
      sender_key: 'curve25519:abc',
      session_id: 'session',
    });

    const result = evaluateNotification(mx, room, event, new Set(), NotificationType.AllMessages);

    expect(result!.event.type).toBe('m.room.encrypted');
    expect(result!.event.content).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
  });

  it('drops the payload even when the algorithm is absent', () => {
    const room = createRoom({}, true);
    const mx = createClient({ [ROOM_ID]: room });

    const result = evaluateNotification(
      mx,
      room,
      encryptedEvent({ ciphertext: 'B'.repeat(2048) }),
      new Set(),
      NotificationType.AllMessages
    );

    expect(result!.event.content).toEqual({});
  });
});
