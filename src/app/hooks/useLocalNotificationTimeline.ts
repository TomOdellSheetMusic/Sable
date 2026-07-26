import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { RoomEvent } from '$types/matrix-sdk';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { allRoomsAtom } from '$state/room-list/roomList';
import { getLocalNotificationCache } from '$client/localNotificationCache';
import { sliceNotificationPage, type StoredNotification } from '$utils/localNotifications';
import { groupNotifications } from '$utils/groupNotifications';

type RoomNotificationsGroup = {
  roomId: string;
  notifications: StoredNotification[];
};
type NotificationTimeline = {
  nextToken?: string;
  groups: RoomNotificationsGroup[];
};
const RELOAD_THROTTLE_MS = 500;

type LoadTimeline = (from?: string) => Promise<void>;
type SilentReloadTimeline = () => Promise<void>;

export const sameNotificationTimeline = (
  a: NotificationTimeline,
  b: NotificationTimeline
): boolean => {
  if (a.nextToken !== b.nextToken || a.groups.length !== b.groups.length) return false;

  return a.groups.every((group, i) => {
    const other = b.groups[i];
    if (!other) return false;
    if (group.roomId !== other.roomId) return false;
    if (group.notifications.length !== other.notifications.length) return false;

    return group.notifications.every((notification, j) => {
      const otherNotification = other.notifications[j];
      if (!otherNotification) return false;
      return (
        notification.event.event_id === otherNotification.event.event_id &&
        // Changes when an encrypted snapshot is replaced by its decrypted one.
        notification.event.type === otherNotification.event.type &&
        notification.dismissed === otherNotification.dismissed
      );
    });
  });
};

export const useLocalNotificationTimeline = (
  paginationLimit: number,
  filterMode: 'all' | 'mentions' = 'mentions',
  includeDone?: boolean
): [NotificationTimeline, LoadTimeline, SilentReloadTimeline] => {
  const mx = useMatrixClient();
  const allRooms = useAtomValue(allRoomsAtom);
  const allJoinedRooms = useMemo(() => new Set(allRooms), [allRooms]);

  const [notificationTimeline, setNotificationTimeline] = useState<NotificationTimeline>({
    groups: [],
  });
  // Re-render on our own read receipts so the per-notification unread dots follow
  // them; the timeline itself is unchanged, so this must not touch it.
  const [, bumpReceiptVersion] = useState(0);

  const cache = getLocalNotificationCache(mx.getSafeUserId());
  const loadedLimitRef = useRef(paginationLimit);

  // Always recomputed from offset 0 over a growing window, so a reload cannot
  // rewind pagination and re-trigger the caller's load-more effect.
  const applyUpTo = useCallback(
    (limit: number) => {
      const allEntries = cache.getEntries().filter((entry) => allJoinedRooms.has(entry.room_id));
      const { page, nextToken } = sliceNotificationPage(
        allEntries,
        0,
        limit,
        filterMode,
        includeDone
      );
      const next: NotificationTimeline = {
        nextToken,
        groups: groupNotifications(page, allJoinedRooms),
      };
      setNotificationTimeline((current) =>
        sameNotificationTimeline(current, next) ? current : next
      );
    },
    [cache, filterMode, includeDone, allJoinedRooms]
  );

  const loadTimeline: LoadTimeline = useCallback(
    async (from) => {
      const limit = from ? Number(from) + paginationLimit : paginationLimit;
      loadedLimitRef.current = limit;
      applyUpTo(limit);
    },
    [applyUpTo, paginationLimit]
  );

  const silentReloadTimeline: SilentReloadTimeline = useCallback(async () => {
    applyUpTo(loadedLimitRef.current);
  }, [applyUpTo]);

  useEffect(() => {
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let lastRun = 0;

    const run = () => {
      lastRun = Date.now();
      applyUpTo(loadedLimitRef.current);
      bumpReceiptVersion((v) => v + 1);
    };

    const reload = () => {
      const elapsed = Date.now() - lastRun;
      if (elapsed >= RELOAD_THROTTLE_MS) {
        run();
        return;
      }
      if (trailing !== undefined) return;
      trailing = setTimeout(() => {
        trailing = undefined;
        run();
      }, RELOAD_THROTTLE_MS - elapsed);
    };

    const unsubscribe = cache.subscribe(reload);
    mx.on(RoomEvent.Receipt, reload);

    return () => {
      unsubscribe();
      mx.off(RoomEvent.Receipt, reload);
      clearTimeout(trailing);
    };
  }, [mx, cache, applyUpTo]);

  return [notificationTimeline, loadTimeline, silentReloadTimeline];
};
