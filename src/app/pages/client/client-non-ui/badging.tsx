import { useAtomValue } from 'jotai';
import { type as osType } from '@tauri-apps/plugin-os';
import { useEffect } from 'react';
import { setTrayBadge } from '$generated/tauri/commands';
import { roomToUnreadAtom } from '$state/room/roomToUnread';
import LogoSVG from '$public/res/svg/logo.svg';
import LogoUnreadSVG from '$public/res/svg/unread.svg';
import LogoHighlightSVG from '$public/res/svg/highlight.svg';
import { setFavicon } from '$utils/dom';
import { isNativeNotificationTauri } from '$features/settings/notifications/TauriNotificationsApiClient';
import { useSetting } from '$state/hooks/settings';
import { settingsAtom } from '$state/settings';
import { registrationAtom } from '$state/serviceWorkerRegistration';
import { mDirectAtom } from '$state/mDirectList';
import { allInvitesAtom } from '$state/room-list/inviteList';
import type { RoomToUnread } from '$types/matrix/room';

// OS-level app badges (macOS dock, Windows taskbar) can't render arbitrary
// numbers, so cap the count at 99 and show "99+" for anything higher.
const MAX_BADGE_COUNT = 99;
const BADGE_OVERFLOW_LABEL = '99+';

// Renders the badge count onto a small PNG so it can be used as a Windows
// taskbar overlay icon (setOverlayIcon). Windows has no numeric badge API.
function renderBadgeOverlay(count: number): Promise<Blob | undefined> {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(undefined);

  const label = count > MAX_BADGE_COUNT ? BADGE_OVERFLOW_LABEL : count.toString();

  // Red notification dot, matching the Linux tray badge.
  context.beginPath();
  context.arc(16, 16, 14, 0, Math.PI * 2);
  context.fillStyle = '#e02d2d';
  context.fill();

  context.fillStyle = '#ffffff';
  const fontSize = label.length > 2 ? 13 : 18;
  context.font = `bold ${fontSize}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, 16, 16);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/png');
  });
}

async function setWindowsBadge(count: number): Promise<void> {
  const [{ getCurrentWindow }, { Image }] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/image'),
  ]);
  const blob = await renderBadgeOverlay(count);
  if (!blob) return;
  const image = await Image.fromBytes(new Uint8Array(await blob.arrayBuffer()));
  await getCurrentWindow().setOverlayIcon(image);
}

async function clearWindowsBadge(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setOverlayIcon(undefined);
}

// Sum only leaf rooms (from === null); space entries aggregate their children
// and would double-count.
function getUnreadTotals(roomToUnread: RoomToUnread, mDirects?: Set<string>) {
  let total = 0;
  let highlightTotal = 0;
  let badge = 0;
  let notification = false;
  let highlight = false;
  roomToUnread.forEach((unread, roomId) => {
    if (unread.from === null) {
      total += unread.total;
      highlightTotal += unread.highlight;
      // DMs count every new message (rapid messages from one sender all count);
      // other rooms count mentions only, which is too noisy otherwise.
      badge += mDirects?.has(roomId) ? unread.total : unread.highlight;
    }
    if (unread.total > 0) {
      notification = true;
    }
    if (unread.highlight > 0) {
      highlight = true;
    }
  });
  return { total, highlightTotal, badge, notification, highlight };
}

// Updates document.title with the mention (highlight) count. Total unread
// is too noisy for a tab title; the OS app badge already uses the same
// highlightTotal value for consistency.
export function PageTitleUpdater() {
  const roomToUnread = useAtomValue(roomToUnreadAtom);

  useEffect(() => {
    const { highlightTotal } = getUnreadTotals(roomToUnread);
    document.title = highlightTotal > 0 ? `(${highlightTotal}) Sable Client` : 'Sable Client';
  }, [roomToUnread]);

  return null;
}

export function FaviconUpdater() {
  const roomToUnread = useAtomValue(roomToUnreadAtom);
  const mDirects = useAtomValue(mDirectAtom);
  const invites = useAtomValue(allInvitesAtom);
  const [backgroundPushEnabled] = useSetting(settingsAtom, 'backgroundPushEnabled');
  const [faviconForMentionsOnly] = useSetting(settingsAtom, 'faviconForMentionsOnly');
  const registration = useAtomValue(registrationAtom);

  useEffect(() => {
    const { total, badge, notification, highlight } = getUnreadTotals(roomToUnread, mDirects);
    // Include pending invites so new chat invitations show up on the badge too.
    const appBadgeCount = badge + invites.length;

    if (highlight) {
      setFavicon(LogoHighlightSVG);
    } else if (!faviconForMentionsOnly && notification) {
      setFavicon(LogoUnreadSVG);
    } else {
      setFavicon(LogoSVG);
    }
    try {
      // Badge with the count of new DMs + mentions + invites. DMs count every
      // message (so rapid messages from one user all add up); other rooms count
      // mentions only, since total unread is too noisy for an OS-level badge.
      if (isNativeNotificationTauri()) {
        const badgeCount = appBadgeCount > 0 ? appBadgeCount : undefined;
        if (osType() === 'linux') {
          // Linux has no taskbar badge; the count goes on the tray icon instead.
          setTrayBadge({ count: badgeCount ?? null }).catch(() => {});
        } else if (osType() === 'windows') {
          // Windows has no numeric badge API; render the count onto an overlay
          // icon instead. macOS caps the badge at 99+ via setBadgeCount.
          if (badgeCount === undefined) {
            clearWindowsBadge().catch(() => {});
          } else {
            setWindowsBadge(badgeCount).catch(() => {});
          }
        } else {
          // macOS dock badge. setBadgeCount only accepts a number, so cap it
          // at 99 (the OS renders "99+" for anything higher).
          const capped =
            badgeCount === undefined ? undefined : Math.min(badgeCount, MAX_BADGE_COUNT);
          import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(capped))
            .catch(() => {});
        }
      } else if (appBadgeCount > 0) {
        navigator.setAppBadge(appBadgeCount);
      } else {
        navigator.clearAppBadge();
      }
      if (backgroundPushEnabled && registration) {
        if (total === 0) {
          // All rooms read — clear every notification.
          registration.getNotifications().then((notifs) => notifs.forEach((n) => n.close()));
        } else {
          // Dismiss notifications for individual rooms that are now fully read.
          registration.getNotifications().then((notifs) => {
            notifs.forEach((n) => {
              const notifRoomId = n.data?.room_id;
              if (!notifRoomId) return;
              const roomUnread = roomToUnread.get(notifRoomId);
              if (!roomUnread || (roomUnread.total === 0 && roomUnread.highlight === 0)) {
                n.close();
              }
            });
          });
        }
      }
    } catch {
      // Likely Firefox/Gecko-based and doesn't support badging API
    }
  }, [
    roomToUnread,
    mDirects,
    invites,
    backgroundPushEnabled,
    registration,
    faviconForMentionsOnly,
  ]);

  return null;
}
