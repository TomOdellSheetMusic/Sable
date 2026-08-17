import { useEffect, useMemo, useState } from 'react';
import type { User } from '$types/matrix-sdk';
import { UserEvent } from '$types/matrix-sdk';
import { useMatrixClient } from './useMatrixClient';

export enum Presence {
  Online = 'online',
  Unavailable = 'unavailable',
  Offline = 'offline',
}

export type UserPresence = {
  presence: Presence;
  status?: string;
  active: boolean;
  lastActiveTs?: number;
};

const getUserPresence = (user: User): UserPresence => ({
  presence: user.presence as Presence,
  status: user.presenceStatusMsg,
  active: user.currentlyActive,
  lastActiveTs: user.getLastActiveTs(),
});

export const useUserPresence = (userId: string): UserPresence | undefined => {
  const mx = useMatrixClient();
  const [presence, setPresence] = useState<UserPresence | undefined>(() => {
    const user = mx.getUser(userId);
    return user ? getUserPresence(user) : undefined;
  });

  useEffect(() => {
    // Listen on the client rather than the User object directly. Presence for
    // bridged users (e.g. Discord) is delivered lazily by PresenceSyncManager,
    // which creates the User on the fly. The client re-emits user events for
    // every user (including ones created after mount), so this hook updates
    // even when the User object did not exist when the component mounted.
    const refresh = () => {
      const user = mx.getUser(userId);
      setPresence(user ? getUserPresence(user) : undefined);
    };
    refresh();

    mx.on(UserEvent.Presence, refresh);
    mx.on(UserEvent.CurrentlyActive, refresh);
    mx.on(UserEvent.LastPresenceTs, refresh);

    return () => {
      mx.removeListener(UserEvent.Presence, refresh);
      mx.removeListener(UserEvent.CurrentlyActive, refresh);
      mx.removeListener(UserEvent.LastPresenceTs, refresh);
    };
  }, [mx, userId]);

  return presence;
};

export const usePresenceLabel = (): Record<Presence, string> =>
  useMemo(
    () => ({
      [Presence.Online]: 'Active',
      [Presence.Unavailable]: 'Busy',
      [Presence.Offline]: 'Away',
    }),
    []
  );
