import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Spinner } from 'folds';
import type { EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import { ModalOverlay } from '$components/modal-overlay/ModalOverlay';
import { useCreateObjectURL } from '$hooks/useObjectURL';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication';
import { useRenderableMediaUrl } from '$hooks/useRenderableMediaUrl';
import type { IImageInfo } from '$types/matrix/common';
import {
  decryptFile,
  downloadEncryptedMedia,
  mxcUrlToHttp,
  rewriteAuthenticatedMediaUrl,
} from '$utils/matrix';
import { FALLBACK_MIMETYPE } from '$utils/mimeTypes';
import { setMediaEncryption } from '$utils/tauriMediaEncryption';
import { isTauri } from '@tauri-apps/api/core';
import { ImageViewer } from './ImageViewer';

export type RoomMediaItem = {
  eventId: string;
  body: string;
  filename?: string;
  url: string;
  info?: IImageInfo;
  mimeType?: string;
  encInfo?: EncryptedAttachmentInfo;
};

type RoomMediaViewerProps = {
  items: RoomMediaItem[];
  selectedEventId: string;
  requestClose: () => void;
  selectEvent: (eventId: string) => void;
};

type ResolvedMedia = { item: RoomMediaItem; src: string };

function ResolvedRoomMedia({
  item,
  requestClose,
  onPrevious,
  onNext,
}: {
  item: RoomMediaItem;
  requestClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const createObjectURL = useCreateObjectURL();
  const rawMediaUrl = useMemo(
    () => (item.url.startsWith('http') ? item.url : mxcUrlToHttp(mx, item.url, useAuthentication)),
    [item.url, mx, useAuthentication]
  );
  const resolvedMediaUrl = useRenderableMediaUrl(
    item.encInfo ? undefined : (rawMediaUrl ?? undefined)
  );

  // The previously resolved image stays mounted while the next one loads, so that
  // stepping through the gallery does not tear the viewer — and with it the Android
  // immersive mode — down and back up between every image.
  const [resolved, setResolved] = useState<ResolvedMedia>();
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    const resolve = async () => {
      const { encInfo, mimeType } = item;
      if (encInfo) {
        if (!rawMediaUrl) throw new Error('Invalid media URL');
        if (isTauri()) {
          await setMediaEncryption(rawMediaUrl, encInfo, mimeType ?? FALLBACK_MIMETYPE);
          return rewriteAuthenticatedMediaUrl(rawMediaUrl)!;
        }
        return createObjectURL(
          downloadEncryptedMedia(rawMediaUrl, (buffer) =>
            decryptFile(buffer, mimeType ?? FALLBACK_MIMETYPE, encInfo)
          )
        );
      }
      return resolvedMediaUrl ?? rawMediaUrl ?? item.url;
    };

    resolve()
      .then((src) => {
        if (requestRef.current !== request) return;
        // Bail on an unchanged result: re-setting it would re-run this effect.
        setResolved((prev) => (prev?.item === item && prev.src === src ? prev : { item, src }));
      })
      .catch(() => undefined);
  }, [item, rawMediaUrl, resolvedMediaUrl, createObjectURL]);

  const loading = resolved?.item.eventId !== item.eventId;

  return (
    <>
      {resolved && (
        <ImageViewer
          alt={resolved.item.body}
          filename={resolved.item.filename}
          src={resolved.src}
          info={resolved.item.info}
          requestClose={requestClose}
          onPrevious={onPrevious}
          onNext={onNext}
        />
      )}
      {loading && (
        <Box
          grow="Yes"
          alignItems="Center"
          justifyContent="Center"
          style={resolved ? { position: 'absolute', inset: 0, background: '#0009' } : undefined}
        >
          <Spinner variant="Secondary" size="400" />
        </Box>
      )}
    </>
  );
}

export function RoomMediaViewer({
  items,
  selectedEventId,
  requestClose,
  selectEvent,
}: RoomMediaViewerProps) {
  const selectedIndex = items.findIndex((mediaItem) => mediaItem.eventId === selectedEventId);
  const item = items[selectedIndex];

  // The selected event can vanish under us, most often through a redaction.
  useEffect(() => {
    if (!item) requestClose();
  }, [item, requestClose]);

  if (!item) return null;

  return (
    <ModalOverlay open requestClose={requestClose} mobile="fullscreen" background="#000">
      <ResolvedRoomMedia
        item={item}
        requestClose={requestClose}
        onPrevious={
          selectedIndex > 0 ? () => selectEvent(items[selectedIndex - 1]!.eventId) : undefined
        }
        onNext={
          selectedIndex < items.length - 1
            ? () => selectEvent(items[selectedIndex + 1]!.eventId)
            : undefined
        }
      />
    </ModalOverlay>
  );
}
