import { EventType } from '$types/matrix-sdk';

type NotificationEntry = {
  event: { type: string };
  room_id: string;
};

type RoomNotificationsGroup<N extends NotificationEntry = NotificationEntry> = {
  roomId: string;
  notifications: N[];
};

export const groupNotifications = <N extends NotificationEntry>(
  notifications: N[],
  allowRooms: Set<string>
): RoomNotificationsGroup<N>[] => {
  const groups: RoomNotificationsGroup<N>[] = [];
  notifications.forEach((notification) => {
    if (notification.event.type === (EventType.RoomMember as string)) return;
    if (!allowRooms.has(notification.room_id)) return;

    const groupIndex = groups.length - 1;
    const lastAddedGroup: RoomNotificationsGroup<N> | undefined = groups[groupIndex];
    if (notification.room_id === lastAddedGroup?.roomId) {
      lastAddedGroup.notifications.push(notification);
      return;
    }
    groups.push({
      roomId: notification.room_id,
      notifications: [notification],
    });
  });
  return groups;
};
