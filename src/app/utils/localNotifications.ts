import type { IContent, IEvent, MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { ReceiptType } from '$types/matrix-sdk';
import { NotificationType } from '$types/matrix/room';
import { isDMRoom, isNotificationEvent } from './room/unread';

export type StoredNotification = {
  room_id: string;
  event: IEvent;
  ts: number;
  highlight: boolean;
  isDM: boolean;
  dismissed?: boolean;
};

export const MAX_BODY_LENGTH = 500;

// HTML cannot be sliced without breaking tags, so oversized messages lose it.
// Ciphertext is dropped: multi-KB, shares the session's localStorage budget, and
// is never rendered. Always copies — the SDK mutates `content` in place.
const truncateContent = (content: IContent, storeContent: boolean): IContent => {
  if (content.ciphertext !== undefined) {
    return typeof content.algorithm === 'string' ? { algorithm: content.algorithm } : {};
  }

  if (!storeContent) {
    return typeof content.msgtype === 'string' ? { msgtype: content.msgtype } : {};
  }

  const body = typeof content.body === 'string' ? content.body : undefined;
  const formattedBody =
    typeof content.formatted_body === 'string' ? content.formatted_body : undefined;

  const bodyTooLong = body !== undefined && body.length > MAX_BODY_LENGTH;
  const formattedTooLong = formattedBody !== undefined && formattedBody.length > MAX_BODY_LENGTH;

  const truncated: IContent = { ...content };
  if (!bodyTooLong && !formattedTooLong) return truncated;

  if (bodyTooLong) truncated.body = `${body.slice(0, MAX_BODY_LENGTH)}…`;
  delete truncated.formatted_body;
  delete truncated.format;
  return truncated;
};

// Defaults to public receipts only, and markAsRead sends a private one when
// hideReads is on.
const latestReceiptTs = (room: Room, userId: string): number | undefined => {
  const timestamps = [ReceiptType.Read, ReceiptType.ReadPrivate]
    .map((type) => room.getReadReceiptForUserId(userId, false, type)?.data?.ts)
    .filter((ts): ts is number => typeof ts === 'number');

  return timestamps.length === 0 ? undefined : Math.max(...timestamps);
};

export const isStoredNotificationRead = (
  room: Room,
  userId: string,
  entry: StoredNotification
): boolean => {
  // hasUserReadEvent warns for events missing from the timeline, so only
  // consult it while the event is known.
  if (room.findEventById(entry.event.event_id)) {
    return room.hasUserReadEvent(userId, entry.event.event_id);
  }

  // Outside the loaded window, which under sliding sync is routine. Compare
  // against the receipt timestamp and default to UNREAD, so a notification is
  // never hidden just because its event is not in memory.
  const receiptTs = latestReceiptTs(room, userId);
  if (receiptTs === undefined) return false;
  return entry.ts <= receiptTs;
};

// actionsForEvent returns {} rather than throwing before push rules sync, which
// reads as "do not notify".
export const arePushRulesReady = (mx: MatrixClient): boolean => mx.pushRules?.global !== undefined;

// The DM override below force-notifies anything in a DM. These types are
// explicitly dont_notify by push rule and must not be resurrected by it.
const DM_OVERRIDE_EXCLUDED = new Set(['m.reaction', 'm.room.create']);

export type EvaluateOptions = {
  /** False when the user opted out of persisting message content. */
  storeContent?: boolean;
};

export const evaluateNotification = (
  mx: MatrixClient,
  room: Room,
  mEvent: MatrixEvent,
  mDirects: Set<string>,
  notificationType: NotificationType,
  options?: EvaluateOptions
): StoredNotification | undefined => {
  if (!arePushRulesReady(mx)) {
    return undefined;
  }

  if (notificationType === NotificationType.Mute) {
    return undefined;
  }

  if (room.isSpaceRoom()) {
    return undefined;
  }

  const userId = mx.getSafeUserId() ?? mx.getUserId() ?? '';
  if (!isNotificationEvent(mEvent, room, userId)) {
    return undefined;
  }

  if (mEvent.getSender() === userId) {
    return undefined;
  }

  if (mEvent.isSending()) {
    return undefined;
  }

  const pushProcessor = mx.pushProcessor;
  const actions = pushProcessor.actionsForEvent(mEvent);
  let notify = actions.notify;
  const highlight = actions.tweaks?.highlight === true;

  const isDM = isDMRoom(room, mDirects);
  notify =
    notify ||
    (isDM &&
      notificationType !== NotificationType.MentionsAndKeywords &&
      !DM_OVERRIDE_EXCLUDED.has(mEvent.getType()));

  if (!notify) {
    return undefined;
  }

  const event: IEvent = {
    event_id: mEvent.getId()!,
    type: mEvent.getType(),
    content: truncateContent(mEvent.getContent(), options?.storeContent !== false),
    sender: mEvent.getSender()!,
    origin_server_ts: mEvent.getTs(),
    room_id: room.roomId,
    unsigned: {},
  };

  return {
    room_id: room.roomId,
    event,
    ts: mEvent.getTs(),
    highlight,
    isDM,
  };
};

export const sliceNotificationPage = (
  all: StoredNotification[],
  offset: number,
  limit: number,
  filterMode: 'all' | 'mentions',
  includeDone?: boolean
): { page: StoredNotification[]; nextToken?: string } => {
  let filtered = all;
  if (filterMode === 'mentions') filtered = filtered.filter((n) => n.highlight || n.isDM);
  if (!includeDone) filtered = filtered.filter((n) => !n.dismissed);
  const sorted = [...filtered].toSorted((a, b) => b.ts - a.ts);
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextToken = nextOffset < sorted.length ? String(nextOffset) : undefined;
  return { page, nextToken };
};

// ---------------------------------------------------------------------------
// Gap backfill — pure decision logic. Testable without network.
// ---------------------------------------------------------------------------

export const GAP_THRESHOLD_MS = 5 * 60 * 1000;
export const MAX_BACKFILL_ROOMS = 30;
const GAP_PAGES_MULTIPLIER_MS = 30 * 60 * 1000;

export type BackfillRoomInfo = {
  roomId: string;
  lastActiveTs: number;
  isSpaceRoom: boolean;
  isMuted: boolean;
};

export const shouldBackfill = (lastSeenTs: number | undefined, now: number): number | undefined => {
  if (lastSeenTs === undefined) return undefined;
  if (now - lastSeenTs < GAP_THRESHOLD_MS) return undefined;
  return lastSeenTs;
};

export const selectBackfillRooms = (rooms: BackfillRoomInfo[], lastSeenTs: number): string[] =>
  rooms
    .filter((r) => !r.isSpaceRoom && !r.isMuted && r.lastActiveTs > lastSeenTs)
    .toSorted((a, b) => b.lastActiveTs - a.lastActiveTs)
    .slice(0, MAX_BACKFILL_ROOMS)
    .map((r) => r.roomId);

export const backfillPageCount = (lastSeenTs: number, now: number): number =>
  now - lastSeenTs > GAP_PAGES_MULTIPLIER_MS ? 2 : 1;
