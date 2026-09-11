import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Box, Button, IconButton, Scroll, Spinner, Text, toRem } from 'folds';
import { ArrowLeft, ArrowRight, sizedIcon, userFallbackIcon } from '$components/icons/phosphor';
import { useAtomValue } from 'jotai';
import { useQuery } from '@tanstack/react-query';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { useRoomNavigate } from '$hooks/useRoomNavigate';
import { RoomCardBase } from '$components/room-card';
import { RoomAvatar } from '$components/room-avatar';
import { useJoinedRoomId } from '$hooks/useJoinedRoomId';
import { getStateEvent } from '$utils/room/hierarchy';
import { nameInitials } from '$utils/common';
import { mxcUrlToHttp } from '$utils/matrix';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication';
import { formatCompactNumber } from '$utils/formatCompactNumber';
import { getMxIdServer } from '$utils/mxIdHelper';
import colorMXID from '$utils/colorMXID';
import { allRoomsAtom } from '$state/room-list/roomList';
import type { RoomBannerContent } from '$types/matrix-sdk-events';
import { CustomStateEvent } from '$types/matrix/room';
import * as css from './PublicSpacesCarousel.css';
import type { MatrixClient } from '$types/matrix-sdk';
import { Method, RoomType } from '$types/matrix-sdk';

const PUBLIC_SPACES_LIMIT = 30;

type PublicSpace = {
  room_id: string;
  name?: string;
  avatar_url?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members: number;
  room_type?: string;
};

function usePublicSpaces(mx: MatrixClient) {
  const userId = mx.getUserId();
  const server = userId ? getMxIdServer(userId) : undefined;

  return useQuery({
    queryKey: [server, 'publicSpaces'],
    queryFn: () =>
      mx.http.authedRequest<{ chunk: PublicSpace[] }>(
        Method.Post,
        '/publicRooms',
        { server },
        {
          limit: PUBLIC_SPACES_LIMIT,
          filter: {
            room_types: [RoomType.Space],
          },
        }
      ),
    enabled: !!server,
    staleTime: 5 * 60 * 1000,
  });
}

function CarouselSpaceCard({
  space,
  onView,
}: {
  space: PublicSpace;
  onView?: (roomIdOrAlias: string) => void;
}) {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const allRooms = useAtomValue(allRoomsAtom);
  const roomIdOrAlias = space.canonical_alias ?? space.room_id;
  const name = space.name || space.room_id;

  // If the user has joined the space we can read its real cover banner from
  // the room.banner state event (loaded via sliding sync). Prefer that as the
  // card background over the square avatar/logo. PublicRooms doesn't return a
  // banner for rooms we haven't joined, so those fall back to the avatar.
  const joinedRoomId = useJoinedRoomId(allRooms, roomIdOrAlias);
  const joinedRoom = joinedRoomId ? mx.getRoom(joinedRoomId) : undefined;
  const bannerState = joinedRoom
    ? getStateEvent(joinedRoom, CustomStateEvent.RoomBanner)
    : undefined;
  const bannerMXC = bannerState?.getContent<RoomBannerContent>()?.url;
  const bannerURI = mxcUrlToHttp(mx, bannerMXC ?? '', useAuthentication);

  const avatarUrl =
    (space.avatar_url && mxcUrlToHttp(mx, space.avatar_url, useAuthentication, 96, 96, 'crop')) ??
    undefined;

  // Background image for the header: banner wins, then avatar/logo.
  const coverUri = bannerURI || avatarUrl;

  return (
    <RoomCardBase>
      <Box style={{ height: toRem(120) }} direction="Column">
        {!coverUri ? (
          <span
            className={css.CarouselCardFallback}
            style={{ backgroundColor: colorMXID(roomIdOrAlias) }}
          />
        ) : (
          <img
            className={css.CarouselCardBanner}
            src={coverUri}
            alt={`${name} cover`}
            draggable="false"
          />
        )}
        <Avatar className={css.CarouselCardAvatar} size="500">
          <RoomAvatar
            roomId={space.room_id}
            src={avatarUrl ?? undefined}
            alt={name}
            renderFallback={() => (
              <Text as="span" size="H3">
                {nameInitials(name)}
              </Text>
            )}
          />
        </Avatar>
      </Box>
      <Box className={css.CarouselCardItems} direction="Column" gap="300">
        <Box gap="200" justifyContent="SpaceBetween">
          <Box grow="Yes" direction="Column" gap="100" style={{ minWidth: 0 }}>
            <Text as="h6" size="H6" truncate>
              {name}
            </Text>
          </Box>
        </Box>
        <Box gap="100">
          {userFallbackIcon('sm')}
          <Text size="T200">{`${formatCompactNumber(space.num_joined_members)} Members`}</Text>
        </Box>
        <Button variant="Secondary" fill="Soft" size="400" onClick={() => onView?.(roomIdOrAlias)}>
          <Text size="B300" truncate>
            View
          </Text>
        </Button>
      </Box>
    </RoomCardBase>
  );
}

export function PublicSpacesCarousel() {
  const mx = useMatrixClient();
  const { navigateSpace } = useRoomNavigate();
  const { data, isLoading, isError } = usePublicSpaces(mx);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerBoxRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const spaces = useMemo(() => {
    if (!data) return [];
    return data.chunk.toSorted((a, b) => b.num_joined_members - a.num_joined_members);
  }, [data]);

  const updateArrows = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const { scrollLeft, scrollWidth, clientWidth } = scroll;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return undefined;

    updateArrows();
    scroll.addEventListener('scroll', updateArrows, { passive: true });

    const resizeObserver = new ResizeObserver(updateArrows);
    resizeObserver.observe(scroll);
    if (innerBoxRef.current) resizeObserver.observe(innerBoxRef.current);

    return () => {
      scroll.removeEventListener('scroll', updateArrows);
      resizeObserver.disconnect();
    };
  }, [updateArrows]);

  const handleScrollBack = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const { offsetWidth, scrollLeft } = scroll;
    scroll.scrollTo({ left: scrollLeft - offsetWidth / 1.3, behavior: 'smooth' });
  };
  const handleScrollFront = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const { offsetWidth, scrollLeft } = scroll;
    scroll.scrollTo({ left: scrollLeft + offsetWidth / 1.3, behavior: 'smooth' });
  };

  if (isLoading) {
    return (
      <Box direction="Column" gap="400">
        <Text size="H4">Explore Public Spaces</Text>
        <Box style={{ padding: toRem(24) }} justifyContent="Center">
          <Spinner size="300" variant="Secondary" />
        </Box>
      </Box>
    );
  }

  if (isError || spaces.length === 0) return null;

  return (
    <Box direction="Column" gap="400">
      <Text size="H4">Explore Public Spaces</Text>
      <Box style={{ position: 'relative' }} direction="Column">
        <Scroll
          ref={scrollRef}
          direction="Horizontal"
          size="0"
          visibility="Hover"
          hideTrack
          data-gestures="scroll"
        >
          <Box shrink="No" alignItems="Center">
            {canScrollLeft && (
              <>
                <div className={css.CarouselGradient({ position: 'Left' })} />
                <IconButton
                  className={css.CarouselBtn({ position: 'Left' })}
                  variant="Secondary"
                  radii="Pill"
                  size="300"
                  outlined
                  onClick={handleScrollBack}
                  aria-label="Scroll spaces left"
                >
                  {sizedIcon(ArrowLeft, '300')}
                </IconButton>
              </>
            )}
            <Box ref={innerBoxRef} alignItems="Inherit" gap="400">
              {spaces.map((space) => (
                <Box
                  key={space.room_id}
                  direction="Row"
                  className={css.CarouselPanel}
                  style={{
                    width: toRem(260),
                    maxWidth: toRem(260),
                    minWidth: toRem(260),
                    flex: `0 0 ${toRem(260)}`,
                    alignItems: 'stretch',
                  }}
                >
                  <CarouselSpaceCard space={space} onView={navigateSpace} />
                </Box>
              ))}
            </Box>
            {canScrollRight && (
              <>
                <div className={css.CarouselGradient({ position: 'Right' })} />
                <IconButton
                  className={css.CarouselBtn({ position: 'Right' })}
                  variant="Primary"
                  radii="Pill"
                  size="300"
                  outlined
                  onClick={handleScrollFront}
                  aria-label="Scroll spaces right"
                >
                  {sizedIcon(ArrowRight, '300')}
                </IconButton>
              </>
            )}
          </Box>
        </Scroll>
      </Box>
    </Box>
  );
}
