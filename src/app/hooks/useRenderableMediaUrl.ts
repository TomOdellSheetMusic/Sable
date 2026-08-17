import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { activeSessionIdAtom } from '$state/sessions';
import {
  fetchMediaBlob,
  getCurrentMediaSessionScope,
  getStableMediaCacheKeyFragment,
} from '$utils/mediaTransport';
import {
  getCachedSWMediaAuthSupport,
  probeSWMediaAuthSupport,
  subscribeSWMediaAuthSupport,
} from '$utils/swMediaAuth';
import { rewriteAuthenticatedMediaUrl } from '$utils/matrix';

type ObjectUrlEntry = {
  refs: number;
  settled: boolean;
  objectUrl?: string;
  promise: Promise<string>;
};

type ResolvedMediaUrlState = {
  cacheKey?: string;
  url?: string;
};

const objectUrlCache = new Map<string, ObjectUrlEntry>();
const inflightRequests = new Map<string, Promise<string>>();
const unreferencedCacheKeys: string[] = [];
const MAX_UNREFERENCED_CACHE_SIZE = 200;

function pruneUnreferencedCache(): void {
  while (unreferencedCacheKeys.length > MAX_UNREFERENCED_CACHE_SIZE) {
    const oldestKey = unreferencedCacheKeys.shift();
    if (!oldestKey) break;
    const entry = objectUrlCache.get(oldestKey);
    if (entry && entry.refs === 0 && entry.settled) {
      if (entry.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
      objectUrlCache.delete(oldestKey);
    }
  }
}

function getObjectUrlCacheKey(sessionScope: string, url: string): string {
  return `${sessionScope}\x00${getStableMediaCacheKeyFragment(url)}`;
}

function normalizeRenderableMediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('blob:')) return url;

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function createObjectUrlEntry(cacheKey: string, url: string): ObjectUrlEntry {
  const entry = {
    refs: 0,
    settled: false,
    objectUrl: undefined,
    promise: Promise.resolve(''),
  } as ObjectUrlEntry;

  entry.promise = fetchMediaBlob(url)
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      entry.objectUrl = objectUrl;
      return objectUrl;
    })
    .finally(() => {
      entry.settled = true;
      inflightRequests.delete(cacheKey);
      if (entry.refs === 0 && entry.objectUrl) {
        if (!unreferencedCacheKeys.includes(cacheKey)) {
          unreferencedCacheKeys.push(cacheKey);
        }
        pruneUnreferencedCache();
      }
    });

  objectUrlCache.set(cacheKey, entry);
  inflightRequests.set(cacheKey, entry.promise);

  return entry;
}

function retainObjectUrlEntry(cacheKey: string, url: string): ObjectUrlEntry {
  const entry = objectUrlCache.get(cacheKey) ?? createObjectUrlEntry(cacheKey, url);
  entry.refs += 1;
  const unrefIndex = unreferencedCacheKeys.indexOf(cacheKey);
  if (unrefIndex !== -1) {
    unreferencedCacheKeys.splice(unrefIndex, 1);
  }
  return entry;
}

function releaseObjectUrlEntry(cacheKey: string): void {
  const entry = objectUrlCache.get(cacheKey);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0 || !entry.settled) return;

  if (!unreferencedCacheKeys.includes(cacheKey)) {
    unreferencedCacheKeys.push(cacheKey);
  }
  pruneUnreferencedCache();
}

type LoopbackEntry = { promise: Promise<string>; url?: string };

// Keyed by the `sable-media` URL so one avatar repeated down a timeline resolves once.
const loopbackCache = new Map<string, LoopbackEntry>();

// Resolved up front because wry rejects a 3xx from a protocol handler, so the loopback cannot
// be reached by redirect. Used on every Tauri platform: it also keeps the immutable caching
// the runtimes strip from custom-protocol responses.
function resolveLoopbackUrl(protocolUrl: string): LoopbackEntry {
  const existing = loopbackCache.get(protocolUrl);
  if (existing) return existing;

  const entry: LoopbackEntry = {
    promise: invoke<string>('prepare_loopback_media', { url: protocolUrl })
      .then((loopbackUrl) => {
        entry.url = loopbackUrl;
        return loopbackUrl;
      })
      .catch(() => {
        // The custom protocol still works, so a failure here costs performance, not media.
        entry.url = protocolUrl;
        return protocolUrl;
      }),
  };
  loopbackCache.set(protocolUrl, entry);
  return entry;
}

// Capabilities are keyed by access token, so they do not survive a session change.
export function clearLoopbackMediaUrlCache(): void {
  loopbackCache.clear();
}

export function clearRenderableMediaUrlCache(): void {
  for (const [cacheKey, entry] of Array.from(objectUrlCache.entries())) {
    if (entry.refs === 0 && entry.settled && entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl);
      objectUrlCache.delete(cacheKey);
    }
  }
  unreferencedCacheKeys.length = 0;
}

export function getRenderableMediaUrlStats(): { cacheSize: number; inflightCount: number } {
  return { cacheSize: objectUrlCache.size, inflightCount: inflightRequests.size };
}

export function useRenderableMediaUrl(url: string | undefined): string | undefined {
  const tauri = isTauri();
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const sessionScope = activeSessionId ?? getCurrentMediaSessionScope();
  const renderableUrl = normalizeRenderableMediaUrl(url);
  const objectUrlCacheKey =
    renderableUrl && !renderableUrl.startsWith('blob:')
      ? getObjectUrlCacheKey(sessionScope, renderableUrl)
      : undefined;
  // Media elements and bare URLs are only safe once the (current) service
  // worker has proven it intercepts authenticated media; until then media goes
  // through the blob path, which attaches the access token in JavaScript.
  const [swMediaAuthSupported, setSwMediaAuthSupported] = useState(
    () => getCachedSWMediaAuthSupport() ?? false
  );
  const protocolUrl = tauri ? (rewriteAuthenticatedMediaUrl(url ?? null) ?? undefined) : undefined;
  // A settled entry resolves synchronously, so a repeated avatar never flashes a fallback.
  const [loopbackUrl, setLoopbackUrl] = useState<string | undefined>(() =>
    tauri && protocolUrl ? loopbackCache.get(protocolUrl)?.url : undefined
  );

  useEffect(() => {
    if (!tauri || !protocolUrl) return undefined;
    const entry = resolveLoopbackUrl(protocolUrl);
    if (entry.url) {
      setLoopbackUrl(entry.url);
      return undefined;
    }
    let cancelled = false;
    void entry.promise.then((resolved) => {
      if (!cancelled) setLoopbackUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [tauri, protocolUrl]);
  const needsBlob = !swMediaAuthSupported;
  const usesExistingObjectUrl = renderableUrl?.startsWith('blob:') ?? false;
  const [resolvedState, setResolvedState] = useState<ResolvedMediaUrlState>(() => {
    const cachedEntry = objectUrlCacheKey ? objectUrlCache.get(objectUrlCacheKey) : undefined;
    return {
      cacheKey: objectUrlCacheKey,
      url: needsBlob && !usesExistingObjectUrl ? cachedEntry?.objectUrl : renderableUrl,
    };
  });

  useEffect(() => {
    if (tauri) return undefined;

    if (getCachedSWMediaAuthSupport() === undefined) {
      void probeSWMediaAuthSupport();
    }
    return subscribeSWMediaAuthSupport(setSwMediaAuthSupported);
  }, [tauri]);

  useEffect(() => {
    if (tauri) return undefined;
    if (!renderableUrl) {
      setResolvedState({ cacheKey: undefined, url: undefined });
      return undefined;
    }

    if (!needsBlob) {
      setResolvedState({ cacheKey: undefined, url: renderableUrl });
      return undefined;
    }

    if (usesExistingObjectUrl) {
      setResolvedState({ cacheKey: undefined, url: renderableUrl });
      return undefined;
    }

    if (!objectUrlCacheKey) {
      setResolvedState({ cacheKey: undefined, url: undefined });
      return undefined;
    }

    const entry = retainObjectUrlEntry(objectUrlCacheKey, renderableUrl);
    let cancelled = false;
    const { objectUrl } = entry;

    setResolvedState({ cacheKey: objectUrlCacheKey, url: objectUrl });

    entry.promise
      .then((resolvedObjectUrl) => {
        if (!cancelled) {
          setResolvedState({ cacheKey: objectUrlCacheKey, url: resolvedObjectUrl });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedState({ cacheKey: objectUrlCacheKey, url: undefined });
        }
      });

    return () => {
      cancelled = true;
      releaseObjectUrlEntry(objectUrlCacheKey);
    };
  }, [needsBlob, objectUrlCacheKey, renderableUrl, tauri, usesExistingObjectUrl]);

  if (tauri) {
    // No protocolUrl fallback while resolving: resolveLoopbackUrl already degrades to it,
    // and handing out the custom-scheme URL first would fail a media element.
    return loopbackUrl;
  }

  if (!needsBlob || usesExistingObjectUrl) {
    return renderableUrl;
  }

  if (resolvedState.cacheKey !== objectUrlCacheKey) {
    return undefined;
  }

  return resolvedState.url;
}
