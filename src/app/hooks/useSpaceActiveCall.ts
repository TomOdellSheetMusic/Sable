import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { roomToParentsAtom } from '$state/room/roomToParents';
import { useActiveRTCSessionIds } from './useMatrixRTCSession';

/**
 * Whether any of the given spaces (or their recursive child rooms) currently
 * has an active MatrixRTC session (i.e. people are in a voice/video call).
 *
 * Re-computes when the global active-session set changes or when the
 * roomToParents mapping (space membership) changes.
 */
export const useSpaceActiveCall = (spaceIds: string | readonly string[]): boolean => {
  const activeRoomIds = useActiveRTCSessionIds();
  const roomToParents = useAtomValue(roomToParentsAtom);

  return useMemo(() => {
    if (activeRoomIds.size === 0) return false;

    const targetIds = new Set(Array.isArray(spaceIds) ? spaceIds : [spaceIds]);
    if (targetIds.size === 0) return false;

    // Recursively walk the parent chain of every active room to see if it
    // belongs to any of the target spaces (or their descendant spaces).
    const visited = new Set<string>();
    const stack = [...activeRoomIds];
    while (stack.length > 0) {
      const roomId = stack.pop()!;
      if (visited.has(roomId)) continue;
      visited.add(roomId);
      const parents = roomToParents.get(roomId);
      if (!parents) continue;
      for (const parentId of parents) {
        if (targetIds.has(parentId)) return true;
        stack.push(parentId);
      }
    }
    return false;
  }, [activeRoomIds, roomToParents, spaceIds]);
};
