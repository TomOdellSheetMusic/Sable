import type { MouseEventHandler } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Badge, Box, Chip, Header, IconButton, Scroll, Text, config, toRem } from 'folds';
import {
  ArrowLeft,
  CaretUp,
  ChatCircle,
  Check,
  Checks,
  composerIcon,
  sizedIcon,
} from '$components/icons/phosphor';
import { useSearchParams } from 'react-router-dom';
import type { Room } from '$types/matrix-sdk';
import { JoinRule, MatrixEvent } from '$types/matrix-sdk';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Page, PageContent, PageContentCenter, PageHeader } from '$components/page';
import { useMatrixClient } from '$hooks/useMatrixClient';
import type { InboxNotificationsPathSearchParams } from '$pages/paths';
import { AsyncStatus, useAsyncCallback } from '$hooks/useAsyncCallback';
import { SequenceCard } from '$components/sequence-card';
import { RoomAvatar, RoomIcon } from '$components/room-avatar';
import { getRoomAvatarUrl } from '$utils/room/display';
import { ScrollTopContainer } from '$components/scroll-top-container';
import { useLocalNotificationTimeline } from '$hooks/useLocalNotificationTimeline';
import { isStoredNotificationRead, type StoredNotification } from '$utils/localNotifications';
import { getLocalNotificationCache } from '$client/localNotificationCache';
import { useSetting } from '$state/hooks/settings';
import { settingsAtom } from '$state/settings';
import { useRoomNavigate } from '$hooks/useRoomNavigate';
import { useRoomUnread } from '$state/hooks/unread';
import { roomToUnreadAtom } from '$state/room/roomToUnread';
import { markAsRead } from '$utils/notifications';
import { ContainerColor } from '$styles/ContainerColor.css';
import { VirtualTile } from '$components/virtualizer';
import { MessagePreview, useRoomMessagePreviewRenderer } from '$components/message-preview';
import { useSettingsLinkBaseUrl } from '$features/settings/useSettingsLinkBaseUrl';
import { ScreenSize, useScreenSizeContext } from '$hooks/useScreenSize';
import { BackRouteHandler } from '$components/BackRouteHandler';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication';

type RoomNotificationsGroupProps = {
  room: Room;
  appBaseUrl: string;
  notifications: StoredNotification[];
  hideReads: boolean;
  onOpen: (roomId: string, eventId: string) => void;
  hour24Clock: boolean;
  dateFormatString: string;
  expanded: boolean;
  onToggleExpanded: (roomId: string, expanded: boolean) => void;
};

type NotificationItemProps = {
  room: Room;
  notification: StoredNotification;
  renderContent: ReturnType<typeof useRoomMessagePreviewRenderer>;
  onOpen: (roomId: string, eventId: string) => void;
  hour24Clock: boolean;
  dateFormatString: string;
};

function NotificationItem({
  room,
  notification,
  renderContent,
  onOpen,
  hour24Clock,
  dateFormatString,
}: NotificationItemProps) {
  const mx = useMatrixClient();
  const liveEvent = useMemo(
    () => room.findEventById(notification.event.event_id),
    [room, notification.event.event_id]
  );
  const event = useMemo(
    () => liveEvent ?? new MatrixEvent(notification.event),
    [liveEvent, notification.event]
  );
  const handleOpen: MouseEventHandler<HTMLButtonElement> = (evt) => {
    evt.stopPropagation();
    onOpen(room.roomId, notification.event.event_id);
  };
  const handleDismiss = () => {
    getLocalNotificationCache(mx.getSafeUserId()).dismiss(notification.event.event_id);
  };
  const isRead = isStoredNotificationRead(room, mx.getSafeUserId(), notification);

  return (
    <SequenceCard
      style={{ padding: config.space.S400 }}
      variant="SurfaceVariant"
      direction="Column"
    >
      <MessagePreview
        room={room}
        event={event}
        renderContent={renderContent}
        actions={
          // One element: MessagePreview drops this straight into a
          // justifyContent="SpaceBetween" row, so separate children get spread
          // across its full width instead of grouping on the right.
          <Box shrink="No" gap="200" alignItems="Center">
            {!isRead && (
              <Badge variant="Secondary" size="200" fill="Solid" radii="Pill" outlined={false} />
            )}
            <Chip onClick={handleOpen} variant="Secondary" radii="400">
              <Text size="T200">Open</Text>
            </Chip>
            <Chip onClick={handleDismiss} variant="Surface" radii="400">
              <Text size="T200">Done</Text>
            </Chip>
          </Box>
        }
        onOpen={handleOpen}
        hour24Clock={hour24Clock}
        dateFormatString={dateFormatString}
      />
    </SequenceCard>
  );
}

function RoomNotificationsGroupComp({
  room,
  appBaseUrl,
  notifications,
  hideReads,
  onOpen,
  hour24Clock,
  dateFormatString,
  expanded,
  onToggleExpanded,
}: Readonly<RoomNotificationsGroupProps>) {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const unread = useRoomUnread(room.roomId, roomToUnreadAtom);
  const renderContent = useRoomMessagePreviewRenderer(room, { settingsLinkBaseUrl: appBaseUrl });
  const handleMarkAsRead = () => {
    markAsRead(mx, room.roomId, hideReads);
  };
  const handleDismissAll = () => {
    getLocalNotificationCache(mx.getSafeUserId()).dismissAllInRoom(room.roomId);
  };
  const MAX_VISIBLE = 5;
  const visible = expanded ? notifications : notifications.slice(0, MAX_VISIBLE);
  const hiddenCount = notifications.length - visible.length;

  return (
    <Box direction="Column" gap="200">
      <Header size="300">
        <Box gap="200" grow="Yes">
          <Avatar size="200" radii="300">
            <RoomAvatar
              roomId={room.roomId}
              src={getRoomAvatarUrl(mx, room, 96, useAuthentication)}
              alt={room.name}
              renderFallback={() => (
                <RoomIcon
                  size="50"
                  roomType={room.getType()}
                  joinRule={room.getJoinRule() ?? JoinRule.Restricted}
                  filled
                />
              )}
            />
          </Avatar>
          <Text size="H4" truncate>
            {room.name}
          </Text>
        </Box>
        <Box shrink="No" gap="100" alignItems="Center">
          {notifications.length > 0 && (
            <Chip
              variant="Surface"
              radii="Pill"
              onClick={handleDismissAll}
              before={sizedIcon(Check, '100')}
            >
              <Text size="T200">Dismiss all</Text>
            </Chip>
          )}
          {unread && (
            <Chip
              variant="Primary"
              radii="Pill"
              onClick={handleMarkAsRead}
              before={sizedIcon(Checks, '100')}
            >
              <Text size="T200">Mark as Read</Text>
            </Chip>
          )}
        </Box>
      </Header>
      <Box direction="Column" gap="100">
        {visible.map((notification) => (
          <NotificationItem
            key={notification.event.event_id}
            room={room}
            notification={notification}
            renderContent={renderContent}
            onOpen={onOpen}
            hour24Clock={hour24Clock}
            dateFormatString={dateFormatString}
          />
        ))}
        {hiddenCount > 0 && (
          <Chip variant="Surface" radii="Pill" onClick={() => onToggleExpanded(room.roomId, true)}>
            <Text size="T200">{hiddenCount} more</Text>
          </Chip>
        )}
      </Box>
    </Box>
  );
}

const useNotificationsSearchParams = (
  searchParams: URLSearchParams
): InboxNotificationsPathSearchParams =>
  useMemo(
    () => ({
      only: searchParams.get('only') ?? undefined,
    }),
    [searchParams]
  );

export function Notifications() {
  const mx = useMatrixClient();
  const [hideReads] = useSetting(settingsAtom, 'hideReads');
  const [hour24Clock] = useSetting(settingsAtom, 'hour24Clock');
  const [dateFormatString] = useSetting(settingsAtom, 'dateFormatString');
  const screenSize = useScreenSizeContext();
  const appBaseUrl = useSettingsLinkBaseUrl();

  const { navigateRoom } = useRoomNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const notificationsSearchParams = useNotificationsSearchParams(searchParams);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopAnchorRef = useRef<HTMLDivElement>(null);

  const filterMode = notificationsSearchParams.only === 'all' ? 'all' : 'mentions';
  const setFilterMode = (mode: 'mentions' | 'all') => {
    if (mode === 'all') {
      setSearchParams(new URLSearchParams({ only: 'all' }));
    } else {
      setSearchParams();
    }
  };
  const [includeDone, setIncludeDone] = useState(false);
  const [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>({});
  const handleToggleExpanded = (roomId: string, expanded: boolean) => {
    setExpandedRooms((prev) => ({ ...prev, [roomId]: expanded }));
  };

  const [notificationTimeline, loadTimelineRaw] = useLocalNotificationTimeline(
    24,
    filterMode,
    includeDone
  );
  const [timelineState, loadTimeline] = useAsyncCallback(loadTimelineRaw);

  const virtualizer = useVirtualizer({
    count: notificationTimeline.groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 4,
  });
  const vItems = virtualizer.getVirtualItems();

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  const lastVItem = vItems.at(-1);
  const lastVItemIndex: number | undefined = lastVItem?.index;
  useEffect(() => {
    if (
      timelineState.status === AsyncStatus.Success &&
      notificationTimeline.groups.length - 1 === lastVItemIndex &&
      notificationTimeline.nextToken
    ) {
      loadTimeline(notificationTimeline.nextToken);
    }
  }, [timelineState, notificationTimeline, lastVItemIndex, loadTimeline]);

  return (
    <Page>
      <PageHeader balance>
        <Box grow="Yes" gap="200">
          <Box grow="Yes" basis="No">
            {screenSize === ScreenSize.Mobile && (
              <BackRouteHandler>
                {(onBack) => <IconButton onClick={onBack}>{composerIcon(ArrowLeft)}</IconButton>}
              </BackRouteHandler>
            )}
          </Box>
          <Box alignItems="Center" gap="200">
            {screenSize !== ScreenSize.Mobile && sizedIcon(ChatCircle, '400')}
            <Text size="H3" truncate>
              Notification Messages
            </Text>
          </Box>
          <Box grow="Yes" basis="No" />
        </Box>
      </PageHeader>

      <Box style={{ position: 'relative' }} grow="Yes">
        <Scroll ref={scrollRef} hideTrack visibility="Hover">
          <PageContent>
            <PageContentCenter>
              <Box direction="Column" gap="200">
                <Box ref={scrollTopAnchorRef} direction="Column" gap="100">
                  <span data-spacing-node />
                  <Text size="L400">Filter</Text>
                  <Box gap="200">
                    <Chip
                      onClick={() => setFilterMode('mentions')}
                      variant={filterMode === 'mentions' ? 'Success' : 'Surface'}
                      aria-pressed={filterMode === 'mentions'}
                      before={filterMode === 'mentions' && sizedIcon(Check, '100')}
                      outlined
                    >
                      <Text size="T200">Mentions &amp; DMs</Text>
                    </Chip>
                    <Chip
                      onClick={() => setFilterMode('all')}
                      variant={filterMode === 'all' ? 'Success' : 'Surface'}
                      aria-pressed={filterMode === 'all'}
                      before={filterMode === 'all' && sizedIcon(Check, '100')}
                      outlined
                    >
                      <Text size="T200">All</Text>
                    </Chip>
                    <Chip
                      onClick={() => setIncludeDone((v) => !v)}
                      variant={includeDone ? 'Success' : 'Surface'}
                      aria-pressed={includeDone}
                      before={includeDone && sizedIcon(Check, '100')}
                      outlined
                    >
                      <Text size="T200">Include done</Text>
                    </Chip>
                  </Box>
                </Box>
                <ScrollTopContainer scrollRef={scrollRef} anchorRef={scrollTopAnchorRef}>
                  <IconButton
                    onClick={() => virtualizer.scrollToOffset(0)}
                    variant="SurfaceVariant"
                    radii="Pill"
                    outlined
                    size="300"
                    aria-label="Scroll to Top"
                  >
                    {composerIcon(CaretUp)}
                  </IconButton>
                </ScrollTopContainer>
                <div
                  style={{
                    position: 'relative',
                    height: virtualizer.getTotalSize(),
                  }}
                >
                  {vItems.map((vItem) => {
                    const group = notificationTimeline.groups[vItem.index];
                    if (!group) return null;
                    const groupRoom = mx.getRoom(group.roomId);
                    if (!groupRoom) return null;

                    return (
                      <VirtualTile
                        virtualItem={vItem}
                        style={{ paddingTop: config.space.S500 }}
                        ref={virtualizer.measureElement}
                        key={vItem.index}
                      >
                        <RoomNotificationsGroupComp
                          room={groupRoom}
                          appBaseUrl={appBaseUrl}
                          notifications={group.notifications}
                          hideReads={hideReads}
                          onOpen={navigateRoom}
                          hour24Clock={hour24Clock}
                          dateFormatString={dateFormatString}
                          expanded={expandedRooms[group.roomId] ?? false}
                          onToggleExpanded={handleToggleExpanded}
                        />
                      </VirtualTile>
                    );
                  })}
                </div>

                {timelineState.status === AsyncStatus.Success &&
                  notificationTimeline.groups.length === 0 && (
                    <Box
                      className={ContainerColor({
                        variant: 'SurfaceVariant',
                      })}
                      style={{
                        padding: config.space.S300,
                        borderRadius: config.radii.R400,
                      }}
                      direction="Column"
                      gap="200"
                    >
                      <Text>No Notifications</Text>
                      <Text size="T200">
                        You don&apos;t have any new notifications to display yet.
                      </Text>
                    </Box>
                  )}

                {timelineState.status === AsyncStatus.Loading && (
                  <Box direction="Column" gap="100">
                    {Array.from({ length: 8 }).map(() => (
                      <SequenceCard
                        variant="SurfaceVariant"
                        key={crypto.randomUUID()}
                        style={{ minHeight: toRem(80) }}
                      />
                    ))}
                  </Box>
                )}
                {timelineState.status === AsyncStatus.Error && (
                  <Box
                    className={ContainerColor({ variant: 'Critical' })}
                    style={{
                      padding: config.space.S300,
                      borderRadius: config.radii.R400,
                    }}
                    direction="Column"
                    gap="200"
                  >
                    <Text size="L400">{(timelineState.error as Error).name}</Text>
                    <Text size="T300">{(timelineState.error as Error).message}</Text>
                  </Box>
                )}
              </Box>
            </PageContentCenter>
          </PageContent>
        </Scroll>
      </Box>
    </Page>
  );
}
