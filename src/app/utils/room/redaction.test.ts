import { describe, it, expect, vi } from 'vitest';
import type { MatrixClient, Room } from '$types/matrix-sdk';
import { EventStatus, MatrixEvent } from '$types/matrix-sdk';
import { isLocalEventId, redactEvent } from './redaction';

const ROOM_ID = '!r:example.org';

const makeMx = () =>
  ({
    redactEvent: vi.fn<() => Promise<{ event_id: string }>>(async () => ({
      event_id: '$redaction',
    })),
    cancelPendingEvent: vi.fn<() => void>(),
  }) as unknown as MatrixClient & {
    redactEvent: ReturnType<typeof vi.fn>;
    cancelPendingEvent: ReturnType<typeof vi.fn>;
  };

const room = { roomId: ROOM_ID } as Room;

const makeEvent = (eventId: string, status: EventStatus | null = null) => {
  const mEvent = new MatrixEvent({
    type: 'm.reaction',
    event_id: eventId,
    room_id: ROOM_ID,
    sender: '@me:example.org',
    content: {},
  });
  mEvent.setStatus(status);
  return mEvent;
};

describe('isLocalEventId', () => {
  it('recognises the local echo prefix', () => {
    expect(isLocalEventId('~!r:example.org:txn1')).toBe(true);
    expect(isLocalEventId('$real')).toBe(false);
  });
});

describe('redactEvent', () => {
  it('redacts an event the server already knows about', async () => {
    const mx = makeMx();
    await redactEvent(mx, room, makeEvent('$real'), { reason: 'spam' });

    expect(mx.redactEvent).toHaveBeenCalledWith(ROOM_ID, '$real', undefined, { reason: 'spam' });
    expect(mx.cancelPendingEvent).not.toHaveBeenCalled();
  });

  it('cancels a queued event instead of redacting a local echo id', async () => {
    const mx = makeMx();
    const mEvent = makeEvent('~!r:example.org:txn1', EventStatus.QUEUED);

    await redactEvent(mx, room, mEvent);

    expect(mx.cancelPendingEvent).toHaveBeenCalledWith(mEvent);
    expect(mx.redactEvent).not.toHaveBeenCalled();
  });

  it('waits for the server id before redacting an event that is in flight', async () => {
    const mx = makeMx();
    const mEvent = makeEvent('~!r:example.org:txn1', EventStatus.SENDING);

    const redacting = redactEvent(mx, room, mEvent);
    await Promise.resolve();
    expect(mx.redactEvent).not.toHaveBeenCalled();

    mEvent.replaceLocalEventId('$real');
    await redacting;

    expect(mx.redactEvent).toHaveBeenCalledWith(ROOM_ID, '$real', undefined, undefined);
  });

  it('gives up when the in flight send fails', async () => {
    const mx = makeMx();
    const mEvent = makeEvent('~!r:example.org:txn1', EventStatus.SENDING);

    const redacting = redactEvent(mx, room, mEvent);
    mEvent.setStatus(EventStatus.NOT_SENT);
    await redacting;

    expect(mx.redactEvent).not.toHaveBeenCalled();
  });
});
