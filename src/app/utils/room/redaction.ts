import type { IRedactOpts, MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { EventStatus, MatrixEventEvent } from '$types/matrix-sdk';

const LOCAL_EVENT_ID_PREFIX = '~';

const CANCELLABLE_STATUSES = new Set<EventStatus | null>([
  EventStatus.QUEUED,
  EventStatus.NOT_SENT,
  EventStatus.ENCRYPTING,
]);

export const isLocalEventId = (eventId: string): boolean =>
  eventId.startsWith(LOCAL_EVENT_ID_PREFIX);

export const waitForRemoteEventId = (mEvent: MatrixEvent): Promise<string | undefined> =>
  new Promise((resolve) => {
    const settle = (eventId: string | undefined) => {
      mEvent.off(MatrixEventEvent.LocalEventIdReplaced, onIdReplaced);
      mEvent.off(MatrixEventEvent.Status, onStatus);
      resolve(eventId);
    };
    function onIdReplaced() {
      settle(mEvent.getId());
    }
    function onStatus(_: MatrixEvent, status: EventStatus | null) {
      if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) settle(undefined);
    }
    mEvent.on(MatrixEventEvent.LocalEventIdReplaced, onIdReplaced);
    mEvent.on(MatrixEventEvent.Status, onStatus);

    const eventId = mEvent.getId();
    if (eventId && !isLocalEventId(eventId)) settle(eventId);
    else if (mEvent.status === EventStatus.NOT_SENT || mEvent.status === EventStatus.CANCELLED) {
      settle(undefined);
    }
  });

// mx.redactEvent throws on a local echo id: it resolves the target through
// Room.getPendingEvents(), unavailable under chronological pending event ordering.
export const redactEvent = async (
  mx: MatrixClient,
  room: Room,
  mEvent: MatrixEvent,
  opts?: IRedactOpts
): Promise<void> => {
  let eventId = mEvent.getId();
  if (!eventId) return;

  if (isLocalEventId(eventId)) {
    if (CANCELLABLE_STATUSES.has(mEvent.status)) {
      mx.cancelPendingEvent(mEvent);
      return;
    }
    eventId = await waitForRemoteEventId(mEvent);
    if (!eventId || isLocalEventId(eventId)) return;
  }

  await mx.redactEvent(room.roomId, eventId, undefined, opts);
};
