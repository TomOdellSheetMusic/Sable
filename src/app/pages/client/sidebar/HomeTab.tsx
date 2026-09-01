import { forwardRef } from 'react';
import { useNavigate } from 'react-router';
import { useAtomValue } from 'jotai';
import { useOrphanRooms } from '$state/hooks/roomList';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { mDirectAtom } from '$state/mDirectList';
import { roomToParentsAtom } from '$state/room/roomToParents';
import { allRoomsAtom } from '$state/room-list/roomList';
import { roomToUnreadAtom } from '$state/room/roomToUnread';
import { getHomePath } from '$pages/pathUtils';
import { ScreenSize, useScreenSizeContext } from '$hooks/useScreenSize';
import { useRoomsUnread } from '$state/hooks/unread';
import { SidebarTab } from '$components/sidebar';
import { useHomeSelected } from '$hooks/router/useRouteSelected';
import { House, getPhosphorIconSize } from '$components/icons/phosphor';
import { useMenuAnchor } from '$hooks/useMenuAnchor';
import { NavMenu } from '$components/nav/NavMenu';
import { useOpenMobileDrawerContent } from '$components/page/MobileNavDrawerContext';
import { useHomeRooms } from '$pages/client/home/useHomeRooms';

type HomeMenuProps = {
  requestClose: () => void;
};
const HomeMenu = forwardRef<HTMLDivElement, HomeMenuProps>(({ requestClose }, ref) => {
  const orphanRooms = useHomeRooms();

  return <NavMenu ref={ref} rooms={orphanRooms} requestClose={requestClose} />;
});
HomeMenu.displayName = 'HomeMenu';

export function HomeTab() {
  const navigate = useNavigate();
  const mx = useMatrixClient();
  const screenSize = useScreenSizeContext();
  const isMobile = screenSize === ScreenSize.Mobile;
  const openMobileDrawerContent = useOpenMobileDrawerContent();

  const mDirects = useAtomValue(mDirectAtom);
  const roomToParents = useAtomValue(roomToParentsAtom);
  const orphanRooms = useOrphanRooms(mx, allRoomsAtom, mDirects, roomToParents);
  const homeUnread = useRoomsUnread(orphanRooms, roomToUnreadAtom);
  const homeSelected = useHomeSelected();
  const menuAnchor = useMenuAnchor<HTMLButtonElement>();

  const handleHomeClick = () => {
    if (isMobile && openMobileDrawerContent) {
      // Open content and slide the drawer back to it, even when already on /home/.
      openMobileDrawerContent(getHomePath());
      return;
    }
    navigate(getHomePath());
  };

  return (
    <SidebarTab
      icon={
        <House size={getPhosphorIconSize('toolbar')} weight={homeSelected ? 'fill' : 'regular'} />
      }
      selected={homeSelected}
      tooltip="Home"
      onClick={handleHomeClick}
      menu={<HomeMenu requestClose={menuAnchor.close} />}
      menuAnchor={menuAnchor}
      unreadHighlight={homeUnread ? homeUnread.highlight > 0 : false}
      unreadCount={
        homeUnread ? (homeUnread.highlight > 0 ? homeUnread.highlight : homeUnread.total) : 0
      }
    />
  );
}
