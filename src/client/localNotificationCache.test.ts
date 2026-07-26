import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredNotification } from '$utils/localNotifications';
import { clearLocalNotificationCache, LocalNotificationCache } from './localNotificationCache';

const userId = '@user:example.com';
const userId2 = '@other:example.com';

const makeEntry = (
  eventId: string,
  roomId = '!room:example.com',
  ts = Date.now(),
  highlight = false,
  dismissed?: boolean,
  isDM = false
): StoredNotification => ({
  room_id: roomId,
  event: {
    event_id: eventId,
    type: 'm.room.message',
    content: { body: `test ${eventId}` },
    sender: '@user:example.com',
    origin_server_ts: ts,
    unsigned: {},
  },
  ts,
  highlight,
  isDM,
  dismissed,
});

/**
 * Every cache instance registers a `storage` listener and can hold a pending
 * debounced write, both of which would bleed into later tests under the same
 * storage key. Track them and tear them down.
 */
const caches: LocalNotificationCache[] = [];
const openCache = (id: string): LocalNotificationCache => {
  const cache = new LocalNotificationCache(id);
  caches.push(cache);
  return cache;
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  while (caches.length > 0) caches.pop()?.destroy();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LocalNotificationCache', () => {
  it('dedup by event_id', () => {
    const cache = openCache(userId);
    const entry = makeEntry('$ev1');
    cache.merge(entry);
    cache.merge(entry);
    expect(cache.getEntries()).toHaveLength(1);
  });

  it('newest-first ordering', () => {
    const cache = openCache(userId);
    cache.merge(makeEntry('$ev1', '!room:example.com', 100));
    cache.merge(makeEntry('$ev2', '!room:example.com', 200));
    cache.merge(makeEntry('$ev3', '!room:example.com', 50));
    const tss = cache.getEntries().map((e) => e.ts);
    expect(tss).toEqual([200, 100, 50]);
  });

  it('MAX_ENTRIES truncation (oldest dropped)', () => {
    const cache = openCache(userId);
    for (let i = 0; i < 310; i++) {
      cache.merge(makeEntry(`$ev${i}`, '!room:example.com', i));
    }
    const entries = cache.getEntries();
    expect(entries).toHaveLength(300);
    expect(entries.at(0)?.ts).toBe(309);
    expect(entries.at(-1)?.ts).toBe(10);
  });

  it('round-trip via destroy() flush', () => {
    const cache = openCache(userId);
    for (let i = 0; i < 5; i++) {
      cache.merge(makeEntry(`$ev${i}`, '!room:example.com', i));
    }
    cache.destroy();

    const restored = openCache(userId);
    expect(restored.getEntries()).toHaveLength(5);
    expect(restored.getEntries().map((e) => e.event.event_id)).toEqual([
      '$ev4',
      '$ev3',
      '$ev2',
      '$ev1',
      '$ev0',
    ]);
  });

  it('keeps removals out of storage', () => {
    const cache = openCache(userId);
    cache.merge(makeEntry('$ev1'));
    cache.merge(makeEntry('$ev2'));
    cache.destroy();

    const reopened = openCache(userId);
    reopened.remove('$ev1');
    reopened.destroy();

    const restored = openCache(userId);
    expect(restored.getEntries().map((e) => e.event.event_id)).toEqual(['$ev2']);
  });

  it('reinstates a removed entry when it is recorded again', () => {
    const cache = openCache(userId);
    cache.merge(makeEntry('$ev1'));
    cache.remove('$ev1');
    cache.merge(makeEntry('$ev1'));
    cache.destroy();

    const restored = openCache(userId);
    expect(restored.getEntries().map((e) => e.event.event_id)).toEqual(['$ev1']);
  });

  it('version mismatch returns empty', () => {
    const key = `sable.notificationCache.v1.${encodeURIComponent(userId)}`;
    localStorage.setItem(key, JSON.stringify({ version: 999, entries: [makeEntry('$ev1')] }));
    const cache = openCache(userId);
    expect(cache.getEntries()).toEqual([]);
  });

  it('corrupt JSON returns empty', () => {
    const key = `sable.notificationCache.v1.${encodeURIComponent(userId)}`;
    localStorage.setItem(key, '{not json');
    const cache = openCache(userId);
    expect(cache.getEntries()).toEqual([]);
  });

  it('QuotaExceededError retry with halving', () => {
    const cache = openCache(userId);
    for (let i = 0; i < 100; i++) {
      cache.merge(makeEntry(`$ev${i}`, '!room:example.com', i));
    }

    let calls = 0;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      calls++;
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    cache.destroy();

    spy.mockRestore();

    expect(calls).toBeGreaterThanOrEqual(7);
  });

  it('clear(userId) touches only that key', () => {
    const cacheA = openCache(userId);
    const cacheB = openCache(userId2);
    cacheA.merge(makeEntry('$evA'));
    cacheB.merge(makeEntry('$evB'));
    cacheA.destroy();
    cacheB.destroy();

    clearLocalNotificationCache(userId);

    const restoredA = openCache(userId);
    const restoredB = openCache(userId2);
    expect(restoredA.getEntries()).toEqual([]);
    expect(restoredB.getEntries()).toHaveLength(1);
  });

  it('cross-tab: two instances merging concurrently both survive', () => {
    const cacheA = openCache(userId);
    const cacheB = openCache(userId);
    cacheA.merge(makeEntry('$evX', '!room:example.com', 100));
    cacheB.merge(makeEntry('$evY', '!room:example.com', 200));
    cacheA.destroy();
    cacheB.destroy();

    const key = `sable.notificationCache.v1.${encodeURIComponent(userId)}`;
    const raw = localStorage.getItem(key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    const eventIds = parsed.entries.map((e: StoredNotification) => e.event.event_id);
    expect(eventIds).toContain('$evX');
    expect(eventIds).toContain('$evY');
  });

  it('dismissed flag preserved on re-record', () => {
    const cache = openCache(userId);
    const entry = makeEntry('$ev1');
    cache.merge(entry);
    cache.dismiss('$ev1');
    cache.merge(makeEntry('$ev1'));
    expect(cache.getEntries().at(0)?.dismissed).toBe(true);
  });

  it('dismissing one entry leaves siblings untouched', () => {
    const cache = openCache(userId);
    const x = makeEntry('$evX', '!room:example.com', 100, false);
    const y = makeEntry('$evY', '!room:example.com', 200, false);
    const z = makeEntry('$evZ', '!room:example.com', 300, false);
    cache.merge(x);
    cache.merge(y);
    cache.merge(z);
    cache.dismiss('$evY');

    const entries = cache.getEntries();
    const find = (id: string) => entries.find((e) => e.event.event_id === id)!;
    expect(find('$evX').dismissed).toBeFalsy();
    expect(find('$evY').dismissed).toBe(true);
    expect(find('$evZ').dismissed).toBeFalsy();
  });

  it('badge count excludes dismissed and non-highlights', () => {
    const cache = openCache(userId);
    cache.merge(makeEntry('$ev1', '!room:example.com', 100, true, false)); // highlight, undismissed
    cache.merge(makeEntry('$ev2', '!room:example.com', 200, true, true)); // highlight, dismissed
    cache.merge(makeEntry('$ev3', '!room:example.com', 300, false, false)); // non-highlight, undismissed

    const undismissedHighlights = cache.getEntries().filter((e) => e.highlight && !e.dismissed);
    expect(undismissedHighlights).toHaveLength(1);
    expect(undismissedHighlights.at(0)?.event.event_id).toBe('$ev1');
  });

  it('lastSeenTs with 60s throttle', () => {
    const cache = openCache(userId);
    cache.updateLastSeenTs(1000);
    expect(cache.getLastSeenTs()).toBe(1000);

    cache.updateLastSeenTs(1001);
    expect(cache.getLastSeenTs()).toBe(1000);

    cache.updateLastSeenTs(61001);
    expect(cache.getLastSeenTs()).toBe(61001);
  });

  it('subscribe notifies on merge', () => {
    const cache = openCache(userId);
    const listener = vi.fn<() => void>();
    cache.subscribe(listener);
    cache.merge(makeEntry('$ev1'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('persists lastSeenTs across a flush and reload', () => {
    const cache = openCache(userId);
    cache.updateLastSeenTs(12345);
    cache.merge(makeEntry('$ev1'));
    cache.destroy();

    const restored = openCache(userId);
    expect(restored.getLastSeenTs()).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// mergeMany / countEntries — a batched scan must not notify per entry
// ---------------------------------------------------------------------------

describe('LocalNotificationCache batching', () => {
  it('notifies once for a whole batch', () => {
    const cache = openCache(userId);
    const listener = vi.fn<() => void>();
    cache.subscribe(listener);

    cache.mergeMany([makeEntry('$a', '!r:e.com', 3), makeEntry('$b', '!r:e.com', 2)]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(cache.getEntries()).toHaveLength(2);
  });

  it('does not notify for an empty batch', () => {
    const cache = openCache(userId);
    const listener = vi.fn<() => void>();
    cache.subscribe(listener);

    cache.mergeMany([]);

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps entries newest-first across a batch', () => {
    const cache = openCache(userId);

    cache.mergeMany([
      makeEntry('$old', '!r:e.com', 100),
      makeEntry('$new', '!r:e.com', 300),
      makeEntry('$mid', '!r:e.com', 200),
    ]);

    expect(cache.getEntries().map((e) => e.event.event_id)).toEqual(['$new', '$mid', '$old']);
  });

  it('dedupes within a batch and preserves an existing dismissal', () => {
    const cache = openCache(userId);
    cache.merge(makeEntry('$a', '!r:e.com', 100));
    cache.dismiss('$a');

    cache.mergeMany([makeEntry('$a', '!r:e.com', 100), makeEntry('$a', '!r:e.com', 100)]);

    const entries = cache.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.dismissed).toBe(true);
  });

  it('counts in place without copying entries', () => {
    const cache = openCache(userId);
    cache.mergeMany([
      makeEntry('$a', '!r:e.com', 300, true),
      makeEntry('$b', '!r:e.com', 200, false),
      makeEntry('$c', '!r:e.com', 100, true, true),
    ]);

    expect(cache.countEntries((e) => e.highlight)).toBe(2);
    expect(cache.countEntries((e) => e.highlight && !e.dismissed)).toBe(1);
    expect(cache.countEntries(() => false)).toBe(0);
  });
});
