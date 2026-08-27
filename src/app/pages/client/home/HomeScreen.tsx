import { useEffect, useMemo } from 'react';
import { Avatar, Box, IconButton, Scroll, Text, toRem } from 'folds';
import { useAtomValue } from 'jotai';
import {
  ChatCircleDots,
  House,
  Phone,
  VideoCamera,
  composerIcon,
  sizedIcon,
  userFallbackIcon,
} from '$components/icons/phosphor';
import { Page, PageContent, PageContentCenter, PageHero, PageHeroSection } from '$components/page';
import { useRoomNavigate } from '$hooks/useRoomNavigate';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { useHomeRooms } from './useHomeRooms';
import { useSetting } from '$state/hooks/settings';
import { settingsAtom } from '$state/settings';
import { factoryRoomIdByActivity } from '$utils/sort';
import { useSelectedOrLastRoom } from '$hooks/router/useSelectedRoom';
import { roomToUnreadAtom } from '$state/room/roomToUnread';
import { useDirectRooms } from '$pages/client/direct/useDirectRooms';
import { getDmOtherMember, getMemberAvatarMxc, getMemberDisplayName } from '$utils/room/display';
import { getMxIdLocalPart, mxcUrlToHttp } from '$utils/matrix';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication';
import { useUserProfile } from '$hooks/useUserProfile';
import { useUserPresence, Presence, usePresenceLabel } from '$hooks/useUserPresence';
import { PresenceBadge, AvatarPresence } from '$components/presence';
import { UserAvatar } from '$components/user-avatar';
import { useRoomName } from '$hooks/useRoomMeta';
import { useCallSession, useCallMembers } from '$hooks/useCall';
import { useActiveRTCSessionIds } from '$hooks/useMatrixRTCSession';
import { fetchMediaBlob } from '$utils/mediaTransport';
import { SequenceCard } from '$components/sequence-card';

type Contact = {
  userId: string;
  roomId: string;
  name: string;
  avatarUrl?: string;
};

function ContactRow({ contact }: { contact: Contact }) {
  const label = usePresenceLabel();
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const { navigateRoom } = useRoomNavigate();
  const presence = useUserPresence(contact.userId);
  // Fetch the user's global profile (independent of room membership, which
  // sliding sync may not have loaded yet) so the avatar/name render without
  // opening the room.
  const profile = useUserProfile(contact.userId);
  const avatarUrl =
    profile.avatarUrl && !contact.avatarUrl
      ? (mxcUrlToHttp(mx, profile.avatarUrl, useAuthentication, 96, 96) ?? undefined)
      : contact.avatarUrl;
  const name = profile.displayName || contact.name;

  if (!presence || presence.presence === Presence.Offline) return null;

  return (
    <SequenceCard variant="SurfaceVariant" radii="500" direction="Column">
      <Box grow="Yes" gap="300" alignItems="Center" style={{ padding: toRem(8) }}>
        <AvatarPresence badge={<PresenceBadge presence={presence.presence} size="200" />}>
          <Avatar size="400" radii="400">
            <UserAvatar
              userId={contact.userId}
              src={avatarUrl}
              alt={name}
              renderFallback={() => userFallbackIcon('sm')}
            />
          </Avatar>
        </AvatarPresence>
        <Box grow="Yes" direction="Column" gap="100" style={{ minWidth: 0 }}>
          <Text size="L400" truncate>
            {name}
          </Text>
          <Text size="T200" priority="400" truncate>
            {presence.status || label[presence.presence]}
          </Text>
        </Box>
        <IconButton
          size="300"
          variant="SurfaceVariant"
          radii="400"
          onClick={() => navigateRoom(contact.roomId)}
          aria-label={`Message ${name}`}
        >
          {sizedIcon(ChatCircleDots, '200')}
        </IconButton>
      </Box>
    </SequenceCard>
  );
}

function ContactsList() {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const directRooms = useDirectRooms();

  const contacts = useMemo<Contact[]>(() => {
    const result: Contact[] = [];
    const seen = new Set<string>();
    directRooms.forEach((roomId) => {
      const room = mx.getRoom(roomId);
      if (!room) return;
      const other = getDmOtherMember(mx, room);
      if (!other) return;
      const userId = other.userId;
      if (!userId || userId === mx.getUserId()) return;
      // A DM that was later turned into a group room can still be tagged as a
      // DM, so the same person may appear in more than one room. Show each
      // person once, preferring the genuine 1:1 DM (exactly two joined
      // members) so "chat" opens the real DM rather than the group room.
      const isOneToOne = room.getJoinedMemberCount() === 2;
      const existing = result.find((c) => c.userId === userId);
      if (existing) {
        if (isOneToOne) {
          existing.roomId = roomId;
          existing.name =
            getMemberDisplayName(room, userId) ?? getMxIdLocalPart(userId) ?? userId;
          const avatarMxc = getMemberAvatarMxc(room, userId);
          existing.avatarUrl = avatarMxc
            ? (mxcUrlToHttp(mx, avatarMxc, useAuthentication, 96, 96) ?? undefined)
            : existing.avatarUrl;
        }
        return;
      }
      seen.add(userId);
      const avatarMxc = getMemberAvatarMxc(room, userId);
      const avatarUrl = avatarMxc
        ? (mxcUrlToHttp(mx, avatarMxc, useAuthentication, 96, 96) ?? undefined)
        : undefined;
      result.push({
        userId,
        roomId,
        name: getMemberDisplayName(room, userId) ?? getMxIdLocalPart(userId) ?? userId,
        avatarUrl,
      });
    });
    return result;
  }, [directRooms, mx, useAuthentication]);

  // Warm the persistent media cache for contact avatars so they render
  // instantly on subsequent visits instead of fetching on first paint.
  useEffect(() => {
    const urls = contacts.map((c) => c.avatarUrl).filter((u): u is string => !!u);
    if (urls.length === 0) return undefined;
    urls.forEach((url) => {
      void fetchMediaBlob(url)
        .then(() => undefined)
        .catch(() => undefined);
    });
    return undefined;
  }, [contacts]);

  return (
    <Box direction="Column" gap="300">
      <Text size="H4">People</Text>
      {contacts.length === 0 ? (
        <Text size="T300" priority="400">
          No contacts yet.
        </Text>
      ) : (
        <Box direction="Column" gap="200">
          {contacts.map((contact) => (
            <ContactRow key={contact.userId} contact={contact} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function CallCard({ roomId }: { roomId: string }) {
  const mx = useMatrixClient();
  const { navigateRoom } = useRoomNavigate();
  const room = mx.getRoom(roomId);
  const roomName = useRoomName(room!);
  const session = useCallSession(room!);
  const members = useCallMembers(room!, session);

  if (!room) return null;

  const memberNames = members
    .map((m) => m.sender)
    .filter((u): u is string => !!u && u !== mx.getUserId())
    .map((u) => getMemberDisplayName(room, u) ?? getMxIdLocalPart(u) ?? u);

  return (
    <SequenceCard variant="SurfaceVariant" radii="500" direction="Column">
      <Box grow="Yes" gap="300" alignItems="Center" style={{ padding: toRem(8) }}>
        <Avatar size="400" radii="400">
          {sizedIcon(Phone, '200')}
        </Avatar>
        <Box grow="Yes" direction="Column" gap="100" style={{ minWidth: 0 }}>
          <Text size="L400" truncate>
            {roomName}
          </Text>
          <Text size="T200" priority="400" truncate>
            {memberNames.length > 0 ? memberNames.join(', ') : 'In a call'}
          </Text>
        </Box>
        <IconButton
          size="300"
          variant="SurfaceVariant"
          radii="400"
          onClick={() => navigateRoom(roomId)}
          aria-label={`Join ${roomName}`}
        >
          {sizedIcon(VideoCamera, '200')}
        </IconButton>
      </Box>
    </SequenceCard>
  );
}

function CallActivitySidebar() {
  const activeRoomIds = useActiveRTCSessionIds();
  const roomIds = Array.from(activeRoomIds);

  return (
    <Box direction="Column" gap="300">
      <Text size="H4">In Calls</Text>
      {roomIds.length === 0 ? (
        <Text size="T300" priority="400">
          No active calls.
        </Text>
      ) : (
        <Box direction="Column" gap="200">
          {roomIds.map((roomId) => (
            <CallCard key={roomId} roomId={roomId} />
          ))}
        </Box>
      )}
      {/* Reserved for games / RPC presence.
      <Box
        direction="Column"
        gap="200"
        style={{
          padding: toRem(12),
          borderRadius: toRem(12),
          border: '1px dashed',
          opacity: 0.6,
        }}
      >
        <Text size="T300" priority="400">
          Games &amp; Activities
        </Text>
        <Text size="T200" priority="400">
          Coming soon — RPC presence will appear here.
        </Text>
      </Box>*/}
    </Box>
  );
}

function HomeRoomRow({ roomId }: { roomId: string }) {
  const mx = useMatrixClient();
  const room = mx.getRoom(roomId);
  const { navigateRoom } = useRoomNavigate();
  const roomName = useRoomName(room!);

  if (!room) return null;

  return (
    <SequenceCard
      as="button"
      variant="SurfaceVariant"
      radii="500"
      onClick={() => navigateRoom(roomId)}
    >
      <Box grow="Yes" gap="300" alignItems="Center" style={{ padding: toRem(8) }}>
        <Avatar size="400" radii="400">
          {sizedIcon(House, '200')}
        </Avatar>
        <Box grow="Yes">
          <Text size="L400" truncate>
            {roomName}
          </Text>
        </Box>
      </Box>
    </SequenceCard>
  );
}

export function HomeScreen() {
  const mx = useMatrixClient();
  const [isShowingAllRoomsInHome] = useSetting(settingsAtom, 'isShowingAllRoomsInHome');
  const rooms = useHomeRooms(isShowingAllRoomsInHome);
  const roomToUnread = useAtomValue(roomToUnreadAtom);
  const selectedRoomId = useSelectedOrLastRoom();

  const orderedRooms = useMemo(
    () => Array.from(rooms).toSorted(factoryRoomIdByActivity(mx)),
    [mx, rooms]
  );

  const displayRooms = useMemo(() => {
    const withUnread = orderedRooms.filter((rId) => {
      const unread = roomToUnread.get(rId);
      const hasUnread = !!unread && (unread.total > 0 || unread.highlight > 0);
      return hasUnread || rId === selectedRoomId;
    });
    return withUnread.length > 0 ? withUnread : orderedRooms;
  }, [orderedRooms, roomToUnread, selectedRoomId]);

  return (
    <Page>
      <Box grow="Yes">
        <Scroll hideTrack visibility="Hover">
          <PageContent>
            <PageContentCenter>
              <Box direction="Column" gap="700" style={{ maxWidth: toRem(964), width: '100%' }}>
                <PageHeroSection>
                  <PageHero
                    icon={
                      <Avatar size="500" radii="400">
                        {composerIcon(House)}
                      </Avatar>
                    }
                    title="Home"
                    subTitle="Your rooms, all in one place."
                  />
                </PageHeroSection>

                <Box direction="Row" gap="500" alignItems="Start">
                  {/* Middle: contacts + rooms */}
                  <Box grow="Yes" direction="Column" gap="700" style={{ minWidth: 0 }}>
                    <ContactsList />

                    {displayRooms.length > 0 && (
                      <Box direction="Column" gap="400">
                        <Text size="H4">Your Rooms</Text>
                        <Box direction="Column" gap="200">
                          {displayRooms.map((roomId) => (
                            <HomeRoomRow key={roomId} roomId={roomId} />
                          ))}
                        </Box>
                      </Box>
                    )}
                  </Box>

                  {/* Right: calls + reserved games/RPC */}
                  <Box direction="Column" gap="500" style={{ width: toRem(320), flexShrink: 0 }}>
                    <CallActivitySidebar />
                  </Box>
                </Box>
              </Box>
            </PageContentCenter>
          </PageContent>
        </Scroll>
      </Box>
    </Page>
  );
}
