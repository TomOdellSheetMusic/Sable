import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent } from '$types/matrix-sdk';
import { ReceiptType } from '$types/matrix-sdk';
import { markAsRead } from './notifications';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

const userId = '@me:example.com';
const roomId = '!room:example.com';

const event = (id: string, sending = false): MatrixEvent =>
  ({
    getId: () => id,
    isSending: () => sending,
  }) as unknown as MatrixEvent;

const makeMx = (events: MatrixEvent[], readUpTo: string | null) => {
  const setRoomReadMarkers = vi
    .fn<
      (
        roomId: string,
        eventId: string,
        read?: MatrixEvent,
        fullyRead?: MatrixEvent
      ) => Promise<void>
    >()
    .mockResolvedValue();
  const sendReadReceipt = vi
    .fn<(event: MatrixEvent, receiptType: ReceiptType) => Promise<void>>()
    .mockResolvedValue();
  const room = {
    getLiveTimeline: () => ({ getEvents: () => events }),
    getEventReadUpTo: () => readUpTo,
  };

  return {
    mx: {
      getRoom: (id: string) => (id === roomId ? room : null),
      getUserId: () => userId,
      setRoomReadMarkers,
      sendReadReceipt,
    } as unknown as MatrixClient,
    setRoomReadMarkers,
    sendReadReceipt,
  };
};

// The live timeline is in timeline order, so the newest event is last. Ordering
// defects belong in the sliding-sync layer, not here.
describe('markAsRead', () => {
  it('marks read up to the last event in the timeline', async () => {
    const { mx, setRoomReadMarkers, sendReadReceipt } = makeMx(
      [event('$older'), event('$newest')],
      null
    );

    await markAsRead(mx, roomId, false);

    expect(setRoomReadMarkers).toHaveBeenCalledWith(roomId, '$newest', expect.anything());
    expect(sendReadReceipt).toHaveBeenCalledWith(expect.anything(), ReceiptType.Read);
    expect(sendReadReceipt.mock.calls[0]?.[0].getId()).toBe('$newest');
  });

  it('does nothing when the last event is already read', async () => {
    const { mx, setRoomReadMarkers, sendReadReceipt } = makeMx(
      [event('$older'), event('$newest')],
      '$newest'
    );

    await markAsRead(mx, roomId, false);

    expect(setRoomReadMarkers).not.toHaveBeenCalled();
    expect(sendReadReceipt).not.toHaveBeenCalled();
  });

  it('ignores events that are still sending', async () => {
    const { mx, sendReadReceipt } = makeMx([event('$confirmed'), event('$local', true)], null);

    await markAsRead(mx, roomId, false);

    expect(sendReadReceipt.mock.calls[0]?.[0].getId()).toBe('$confirmed');
  });

  it('sends a private receipt when reads are hidden', async () => {
    const { mx, setRoomReadMarkers, sendReadReceipt } = makeMx([event('$newest')], null);

    await markAsRead(mx, roomId, true);

    expect(setRoomReadMarkers).toHaveBeenCalledWith(
      roomId,
      '$newest',
      undefined,
      expect.anything()
    );
    expect(sendReadReceipt).toHaveBeenCalledWith(expect.anything(), ReceiptType.ReadPrivate);
  });

  it('does nothing for an empty timeline', async () => {
    const { mx, setRoomReadMarkers, sendReadReceipt } = makeMx([], null);

    await markAsRead(mx, roomId, false);

    expect(setRoomReadMarkers).not.toHaveBeenCalled();
    expect(sendReadReceipt).not.toHaveBeenCalled();
  });
});
