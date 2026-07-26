import { describe, expect, it } from 'vitest';
import type { StoredNotification } from '$utils/localNotifications';
import { sameNotificationTimeline } from './useLocalNotificationTimeline';

const entry = (eventId: string, overrides: Partial<StoredNotification> = {}): StoredNotification =>
  ({
    room_id: '!room:example.com',
    event: { event_id: eventId, type: 'm.room.message' },
    ts: 1000,
    highlight: false,
    isDM: false,
    ...overrides,
  }) as StoredNotification;

const timeline = (nextToken: string | undefined, notifications: StoredNotification[]) => ({
  nextToken,
  groups: notifications.length ? [{ roomId: '!room:example.com', notifications }] : [],
});

describe('sameNotificationTimeline', () => {
  it('treats a freshly recomputed but identical timeline as unchanged', () => {
    const a = timeline('24', [entry('$1'), entry('$2')]);
    const b = timeline('24', [entry('$1'), entry('$2')]);

    expect(sameNotificationTimeline(a, b)).toBe(true);
  });

  it('detects a new notification', () => {
    const a = timeline('24', [entry('$1')]);
    const b = timeline('24', [entry('$1'), entry('$2')]);

    expect(sameNotificationTimeline(a, b)).toBe(false);
  });

  it('detects pagination advancing', () => {
    const a = timeline('24', [entry('$1')]);
    const b = timeline('48', [entry('$1')]);

    expect(sameNotificationTimeline(a, b)).toBe(false);
  });

  it('detects a notification being dismissed', () => {
    const a = timeline('24', [entry('$1')]);
    const b = timeline('24', [entry('$1', { dismissed: true })]);

    expect(sameNotificationTimeline(a, b)).toBe(false);
  });

  it('detects an encrypted snapshot being replaced by its decrypted one', () => {
    const a = timeline('24', [
      entry('$1', { event: { event_id: '$1', type: 'm.room.encrypted' } as never }),
    ]);
    const b = timeline('24', [entry('$1')]);

    expect(sameNotificationTimeline(a, b)).toBe(false);
  });

  it('detects reordering across rooms', () => {
    const a = {
      nextToken: '24',
      groups: [
        { roomId: '!a:example.com', notifications: [entry('$1')] },
        { roomId: '!b:example.com', notifications: [entry('$2')] },
      ],
    };
    const b = {
      nextToken: '24',
      groups: [
        { roomId: '!b:example.com', notifications: [entry('$2')] },
        { roomId: '!a:example.com', notifications: [entry('$1')] },
      ],
    };

    expect(sameNotificationTimeline(a, b)).toBe(false);
  });

  it('treats two empty timelines as unchanged', () => {
    expect(sameNotificationTimeline(timeline(undefined, []), timeline(undefined, []))).toBe(true);
  });
});
