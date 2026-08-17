import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  RoomEvent,
  ParticipantEvent,
  type Participant as LivekitParticipant,
} from 'livekit-client';
import { buildRtcIdentityMap } from '@sableclient/matrixrtc';
import type { Room, CallMembership } from '$types/matrix-sdk';
import { useMatrixClient } from './useMatrixClient';
import { nativeCallAtom, isNativeCallActive } from '$state/nativeCall';
import { livekitJsCallAtom, isLivekitJsCallActive } from '$state/livekitJsCall';
import { callEmbedAtom } from '$state/callEmbed';
import { CallControlEvent } from '$plugins/call/CallControl';
import type { ElementParticipantMediaState } from '$plugins/call/types';

/**
 * The media (mute/camera) state of a call participant that the room
 * navigation can reflect next to their avatar.
 */
export type CallMemberMediaState = {
  /** Microphone is muted (or has no live audio track). */
  micMuted?: boolean;
};

/**
 * Reactively computes the mute/camera state of each call participant
 * currently displayed in the room navigation.
 *
 * The live mute state is only known once the client is actually in a call, and
 * only the backends that expose it contribute entries:
 *  - native calls report per-participant track mute state.
 *  - LiveKit JS calls report per-participant microphone/camera state.
 *  - the Element Call widget reports per-participant media state.
 *
 * Returns a Map keyed by Matrix user ID, always containing an entry for the
 * local user when the given room has an active call.
 */
export const useCallMemberMediaStates = (
  room: Room,
  callMembers: CallMembership[]
): ReadonlyMap<string, CallMemberMediaState> => {
  const mx = useMatrixClient();

  const nativeCall = useAtomValue(nativeCallAtom);
  const livekitJsCall = useAtomValue(livekitJsCallAtom);
  const callEmbed = useAtomValue(callEmbedAtom);

  const roomId = room.roomId;

  // LiveKit and widget mute changes fire on objects held outside the Jotai
  // atoms, so bump a version counter to re-render the hook (the media map is
  // rebuilt on every render below).
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const livekitRoom = livekitJsCall?.room;

  // Subscribe to LiveKit mute/publish events (on the local participant too)
  // so the nav reflects every media change mid-call.
  useEffect(() => {
    if (!livekitRoom || livekitJsCall?.roomId !== roomId) return undefined;

    const attach = (participant: LivekitParticipant) => {
      participant.on(ParticipantEvent.TrackMuted, bump);
      participant.on(ParticipantEvent.TrackUnmuted, bump);
    };
    const detach = (participant: LivekitParticipant) => {
      participant.off(ParticipantEvent.TrackMuted, bump);
      participant.off(ParticipantEvent.TrackUnmuted, bump);
    };

    attach(livekitRoom.localParticipant);
    livekitRoom.remoteParticipants.forEach(attach);
    livekitRoom.on(RoomEvent.ParticipantConnected, attach);
    livekitRoom.on(RoomEvent.ParticipantDisconnected, detach);
    livekitRoom.on(RoomEvent.TrackPublished, bump);
    livekitRoom.on(RoomEvent.TrackUnpublished, bump);
    bump();

    return () => {
      detach(livekitRoom.localParticipant);
      livekitRoom.remoteParticipants.forEach(detach);
      livekitRoom.off(RoomEvent.ParticipantConnected, attach);
      livekitRoom.off(RoomEvent.ParticipantDisconnected, detach);
      livekitRoom.off(RoomEvent.TrackPublished, bump);
      livekitRoom.off(RoomEvent.TrackUnpublished, bump);
    };
  }, [livekitRoom, livekitJsCall?.roomId, roomId]);

  // Subscribe to the Element Call widget's local media state updates.
  useEffect(() => {
    if (!callEmbed || callEmbed.roomId !== roomId) return undefined;
    callEmbed.control.on(CallControlEvent.StateUpdate, bump);
    return () => {
      callEmbed.control.off(CallControlEvent.StateUpdate, bump);
    };
  }, [callEmbed, roomId]);

  // Subscribe to the Element Call widget's per-participant mute state.
  const [widgetParticipants, setWidgetParticipants] = useState<ElementParticipantMediaState[]>([]);
  useEffect(() => {
    if (!callEmbed || callEmbed.roomId !== roomId) return undefined;
    const unsubscribe = callEmbed.onParticipantMediaState(setWidgetParticipants);
    return () => {
      unsubscribe();
      setWidgetParticipants([]);
    };
  }, [callEmbed, roomId]);

  const userIdByIdentity = useMemo(() => buildRtcIdentityMap(callMembers), [callMembers]);
  const localUserId = mx.getSafeUserId?.() ?? mx.getUserId?.() ?? '';

  // Not memoized: `bump()` re-renders on every LiveKit/widget media event,
  // and this map must be rebuilt on each render to stay in sync.
  const states = new Map<string, CallMemberMediaState>();

  if (isNativeCallActive(nativeCall) && nativeCall.roomId === roomId) {
    states.set(localUserId, { micMuted: !nativeCall.microphoneEnabled });
    for (const participant of nativeCall.participants) {
      const userId = userIdByIdentity.get(participant.identity);
      if (userId) states.set(userId, { micMuted: participant.microphone?.muted ?? false });
    }
  } else if (
    isLivekitJsCallActive(livekitJsCall) &&
    livekitJsCall.roomId === roomId &&
    livekitRoom
  ) {
    const local = livekitRoom.localParticipant;
    states.set(localUserId, { micMuted: !local.isMicrophoneEnabled });
    for (const [identity, participant] of livekitRoom.remoteParticipants) {
      const userId = userIdByIdentity.get(identity);
      if (userId) states.set(userId, { micMuted: !participant.isMicrophoneEnabled });
    }
  } else if (callEmbed && callEmbed.roomId === roomId) {
    const control = callEmbed.control;
    states.set(localUserId, { micMuted: !control.microphone });
    for (const participant of widgetParticipants) {
      if (!participant.userId) continue;
      states.set(participant.userId, {
        micMuted: participant.audioEnabled === false,
      });
    }
  }

  return states;
};
