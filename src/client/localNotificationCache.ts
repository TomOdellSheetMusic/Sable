import type { StoredNotification } from '$utils/localNotifications';

const CACHE_VERSION = 1;
const MAX_ENTRIES = 300;
const CACHE_WRITE_DELAY_MS = 500;
const STORAGE_EVENT_DEBOUNCE_MS = 200;
const HEARTBEAT_THROTTLE_MS = 60_000;

type CacheData = {
  version: number;
  entries: StoredNotification[];
  lastSeenTs?: number;
};

const emptyCache = (): CacheData => ({ version: CACHE_VERSION, entries: [] });

const parseCache = (value: string | null): CacheData => {
  if (!value) return emptyCache();
  try {
    const parsed = JSON.parse(value) as Partial<CacheData>;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return emptyCache();
    }
    return { version: CACHE_VERSION, entries: parsed.entries, lastSeenTs: parsed.lastSeenTs };
  } catch {
    return emptyCache();
  }
};

const newestTs = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
};

type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

export class LocalNotificationCache {
  private data: CacheData;
  private dirty: Set<string> = new Set();
  private removed: Set<string> = new Set();
  readonly userId: string;
  private readonly storageKey: string;
  private listeners: Set<() => void> = new Set();
  private writeTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private idleCallbackId: number | undefined;
  private storageDebounceId: ReturnType<typeof setTimeout> | undefined;
  private lastHeartbeatTs: number | undefined;
  private destroyed = false;
  private quotaExhausted = false;

  constructor(userId: string) {
    this.userId = userId;
    this.storageKey = `sable.notificationCache.v1.${encodeURIComponent(userId)}`;
    this.data = this.readStored();
    window.addEventListener('storage', this.onStorageEvent);
  }

  merge(entry: StoredNotification): void {
    this.mergeMany([entry]);
  }

  /** One sort, one write and one notification for the whole batch. */
  mergeMany(entries: StoredNotification[]): void {
    if (this.destroyed || entries.length === 0) return;

    const indexByEventId = new Map(
      this.data.entries.map((entry, index) => [entry.event.event_id, index])
    );
    let reorder = false;

    for (const entry of entries) {
      const eventId = entry.event.event_id;
      this.removed.delete(eventId);

      const idx = indexByEventId.get(eventId);
      if (idx === undefined) {
        indexByEventId.set(eventId, this.data.entries.length);
        this.data.entries.push(entry);
        reorder = true;
      } else {
        const existing = this.data.entries[idx]!;
        // A replacement can carry a different ts, which invalidates the order.
        if (existing.ts !== entry.ts) reorder = true;
        this.data.entries[idx] = { ...entry, dismissed: existing.dismissed || entry.dismissed };
      }

      this.dirty.add(eventId);
    }

    if (reorder) {
      this.data.entries.sort((a, b) => b.ts - a.ts);
      if (this.data.entries.length > MAX_ENTRIES) {
        this.data.entries.length = MAX_ENTRIES;
      }
    }

    this.scheduleWrite();
    this.notifyListeners();
  }

  getEntries(): StoredNotification[] {
    return this.data.entries.map((entry) => ({ ...entry }));
  }

  /** Counts in place — getEntries() would copy every entry just to discard it. */
  countEntries(predicate: (entry: StoredNotification) => boolean): number {
    let count = 0;
    for (const entry of this.data.entries) {
      if (predicate(entry)) count += 1;
    }
    return count;
  }

  remove(eventId: string): void {
    if (this.destroyed) return;
    const idx = this.data.entries.findIndex((e) => e.event.event_id === eventId);
    if (idx !== -1) this.data.entries.splice(idx, 1);
    // Tombstone even when absent here — another tab may still have it on disk.
    this.dirty.delete(eventId);
    this.removed.add(eventId);
    this.scheduleWrite();
    this.notifyListeners();
  }

  getLastSeenTs(): number | undefined {
    return this.data.lastSeenTs;
  }

  updateLastSeenTs(ts: number): void {
    if (this.destroyed) return;
    if (this.lastHeartbeatTs !== undefined && ts - this.lastHeartbeatTs < HEARTBEAT_THROTTLE_MS) {
      return;
    }
    this.lastHeartbeatTs = ts;
    this.data = { ...this.data, lastSeenTs: ts };
    this.scheduleWrite();
  }

  dismiss(eventId: string): void {
    if (this.destroyed) return;
    const entry = this.data.entries.find((e) => e.event.event_id === eventId);
    if (!entry) return;
    entry.dismissed = true;
    this.dirty.add(eventId);
    this.scheduleWrite();
    this.notifyListeners();
  }

  dismissAllInRoom(roomId: string): void {
    if (this.destroyed) return;
    for (const entry of this.data.entries) {
      if (entry.room_id === roomId) {
        entry.dismissed = true;
        this.dirty.add(entry.event.event_id);
      }
    }
    this.scheduleWrite();
    this.notifyListeners();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.writeTimeoutId !== undefined) {
      clearTimeout(this.writeTimeoutId);
      this.writeTimeoutId = undefined;
    }
    if (this.idleCallbackId !== undefined) {
      (globalThis as IdleWindow).cancelIdleCallback?.(this.idleCallbackId);
      this.idleCallbackId = undefined;
    }
    if (this.storageDebounceId !== undefined) {
      clearTimeout(this.storageDebounceId);
      this.storageDebounceId = undefined;
    }
    this.write();
    this.destroyed = true;
    window.removeEventListener('storage', this.onStorageEvent);
    this.listeners.clear();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }

  private readStored(): CacheData {
    try {
      return parseCache(globalThis.localStorage?.getItem(this.storageKey) ?? null);
    } catch {
      // Storage can be disabled for this origin.
      return emptyCache();
    }
  }

  /** Replays unflushed local changes on top of a snapshot read from storage. */
  private applyPending(base: StoredNotification[]): StoredNotification[] {
    const merged = base.filter((entry) => !this.removed.has(entry.event.event_id));

    for (const eventId of this.dirty) {
      const entry = this.data.entries.find((e) => e.event.event_id === eventId);
      if (!entry) continue;
      const idx = merged.findIndex((m) => m.event.event_id === eventId);
      const existing = idx === -1 ? undefined : merged[idx];
      if (existing) {
        merged[idx] = { ...entry, dismissed: existing.dismissed || entry.dismissed };
      } else {
        merged.push(entry);
      }
    }

    merged.sort((a, b) => b.ts - a.ts);
    return merged.slice(0, MAX_ENTRIES);
  }

  private scheduleWrite(): void {
    if (this.writeTimeoutId !== undefined || this.idleCallbackId !== undefined) return;
    this.writeTimeoutId = setTimeout(() => {
      this.writeTimeoutId = undefined;
      const idleWindow = globalThis as IdleWindow;
      if (typeof idleWindow.requestIdleCallback === 'function') {
        this.idleCallbackId = idleWindow.requestIdleCallback(
          () => {
            this.idleCallbackId = undefined;
            this.write();
          },
          { timeout: 2000 }
        );
        return;
      }
      this.write();
    }, CACHE_WRITE_DELAY_MS);
  }

  private write(): void {
    // Latched after a total quota failure: without this every later write
    // replays the whole halving loop, ~9 stringify+setItem attempts each time.
    if (this.quotaExhausted) return;

    const stored = this.readStored();
    const lastSeenTs = newestTs(this.data.lastSeenTs, stored.lastSeenTs);

    let entries = this.applyPending(stored.entries);
    for (;;) {
      const nextData: CacheData = { version: CACHE_VERSION, entries, lastSeenTs };
      try {
        globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(nextData));
        this.commit(nextData);
        return;
      } catch {
        if (entries.length <= 1) {
          // Out of quota even at a single entry. Give the space back rather than
          // competing with the session token write, which has no such fallback.
          this.quotaExhausted = true;
          try {
            globalThis.localStorage?.removeItem(this.storageKey);
          } catch {
            // Nothing further we can do.
          }
          return;
        }
        entries = entries.slice(0, Math.floor(entries.length / 2));
      }
    }
  }

  private commit(next: CacheData): void {
    this.data = next;
    this.dirty.clear();
    this.removed.clear();
  }

  private onStorageEvent = (e: StorageEvent): void => {
    if (e.key !== this.storageKey) return;
    if (this.storageDebounceId !== undefined) {
      clearTimeout(this.storageDebounceId);
    }
    this.storageDebounceId = setTimeout(() => {
      this.storageDebounceId = undefined;
      const disk = this.readStored();
      this.data = {
        version: CACHE_VERSION,
        entries: this.applyPending(disk.entries),
        lastSeenTs: newestTs(this.data.lastSeenTs, disk.lastSeenTs),
      };
      this.notifyListeners();
    }, STORAGE_EVENT_DEBOUNCE_MS);
  };
}

export function clearLocalNotificationCache(userId: string): void {
  try {
    globalThis.localStorage?.removeItem(`sable.notificationCache.v1.${encodeURIComponent(userId)}`);
  } catch {
    // Storage can be disabled for this origin; logout must continue regardless.
  }
  instances.delete(userId);
}

// Singleton keyed by userId so the recorder and the timeline hook share one instance.
const instances = new Map<string, LocalNotificationCache>();

export const getLocalNotificationCache = (userId: string): LocalNotificationCache => {
  let cache = instances.get(userId);
  if (!cache) {
    cache = new LocalNotificationCache(userId);
    instances.set(userId, cache);
  }
  return cache;
};

export const destroyLocalNotificationCache = (userId: string): void => {
  const cache = instances.get(userId);
  if (cache) {
    cache.destroy();
    instances.delete(userId);
  }
};
