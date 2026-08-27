import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  ClientEvent,
  EventTimeline,
  EventType,
  MatrixRTCSession,
  MatrixRTCSessionManagerEvents,
  RoomStateEvent,
} from '$types/matrix-sdk';
import { useMatrixClient } from './useMatrixClient';
import { getSlidingSyncManager } from '$client/initMatrix';

/**
 * The set of room IDs that currently have an active MatrixRTC session.
 * Updated by a single global subscription to `mx.matrixRTC`, so N consumers
 * share one listener pair instead of each adding their own (which exceeded
 * Node's default EventEmitter limit of 10 when 11+ rooms were visible).
 */
type ActiveRTCSessionIds = ReadonlySet<string>;

const MatrixRTCSessionContext = createContext<ActiveRTCSessionIds>(new Set());

/**
 * Rooms that have `m.call.member` state events — i.e. a call may be happening.
 * Sliding sync only loads $ME/$LAZY members for list rooms, so the MatrixRTC
 * membership computation rejects participants who aren't in the loaded roster.
 * We detect these candidate rooms from their raw state, then subscribe to them
 * (loading the full roster) so the call can be confirmed.
 */
const getCandidateRoomIds = (mx: ReturnType<typeof useMatrixClient>): string[] => {
  const candidates: string[] = [];
  for (const room of mx.getRooms()) {
    const state = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    const callMemberEvents = state?.getStateEvents(EventType.GroupCallMemberPrefix);
    if (callMemberEvents && callMemberEvents.length > 0) {
      candidates.push(room.roomId);
    }
  }
  return candidates;
};

/**
 * Enumerates the rooms that currently have an active MatrixRTC session by
 * computing memberships directly from each room's `m.call.member` state events
 * via `MatrixRTCSession.sessionMembershipsForSlot` — the same reliable source
 * `useCallMembers` uses.
 */
const getActiveRoomIds = async (mx: ReturnType<typeof useMatrixClient>): Promise<Set<string>> => {
  const active = new Set<string>();
  const rooms = mx.getRooms();
  await Promise.all(
    rooms.map(async (room) => {
      try {
        const session = mx.matrixRTC.getRoomSession(room);
        const memberships = await MatrixRTCSession.sessionMembershipsForSlot(
          room,
          session.slotDescription
        );
        // A call is "active" when at least one other participant is present.
        const hasRemote = memberships.some((m) => (m.userId ?? m.sender) !== mx.getUserId());
        if (hasRemote) active.add(room.roomId);
      } catch {
        // Ignore rooms whose memberships can't be computed (e.g. not loaded).
      }
    })
  );
  return active;
};

export function MatrixRTCSessionProvider({ children }: { children: ReactNode }): ReactElement {
  const mx = useMatrixClient();
  const [activeRoomIds, setActiveRoomIds] = useState<ActiveRTCSessionIds>(new Set());
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let disposed = false;

    const resync = () => {
      if (disposed) return;
      void getActiveRoomIds(mx).then((ids) => {
        if (disposed) return;
        setActiveRoomIds(ids);
      });
    };

    // Debounce resyncs: membership computation is async, and a burst of state
    // events (e.g. initial room-list hydration) would otherwise trigger many
    // overlapping computations. Re-run shortly after the last change so the
    // async membership read has settled.
    const scheduleResync = () => {
      if (resyncTimer.current !== undefined) clearTimeout(resyncTimer.current);
      resyncTimer.current = setTimeout(resync, 50);
    };

    const handleStart = (roomId: string) => {
      setActiveRoomIds((prev) => {
        if (prev.has(roomId)) return prev;
        const next = new Set(prev);
        next.add(roomId);
        return next;
      });
    };
    const handleEnd = (roomId: string) => {
      setActiveRoomIds((prev) => {
        if (!prev.has(roomId)) return prev;
        const next = new Set(prev);
        next.delete(roomId);
        return next;
      });
    };

    // Subscribe to candidate call rooms so the full member roster loads,
    // allowing their memberships to be computed. Without this, sliding sync's
    // lazy member loading means call participants aren't in the roster and the
    // membership computation rejects them.
    const subscribeCandidates = () => {
      const manager = getSlidingSyncManager(mx);
      if (!manager) return;
      for (const roomId of getCandidateRoomIds(mx)) {
        manager.subscribeToCallRoom(roomId);
      }
    };

    mx.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, handleStart);
    mx.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, handleEnd);
    mx.on(ClientEvent.Room, scheduleResync);
    mx.on(RoomStateEvent.Events, () => {
      subscribeCandidates();
      scheduleResync();
    });

    // Initial seed.
    subscribeCandidates();
    scheduleResync();

    return () => {
      disposed = true;
      if (resyncTimer.current !== undefined) clearTimeout(resyncTimer.current);
      mx.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, handleStart);
      mx.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, handleEnd);
      mx.off(ClientEvent.Room, scheduleResync);
      mx.off(RoomStateEvent.Events, subscribeCandidates);
    };
  }, [mx]);

  return (
    <MatrixRTCSessionContext.Provider value={activeRoomIds}>
      {children}
    </MatrixRTCSessionContext.Provider>
  );
}

/**
 * Returns the set of room IDs that currently have an active MatrixRTC session.
 * Backed by a single global subscription (see MatrixRTCSessionProvider).
 */
export function useActiveRTCSessionIds(): ActiveRTCSessionIds {
  return useContext(MatrixRTCSessionContext);
}
