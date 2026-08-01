import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

// Tauri webviews don't HTTP-cache responses from the sable-media scheme handler, so
// every remount round-trips into the native layer. Session object URLs avoid that.
const MAX_ENTRIES = 256;

type CacheEntry = string | Promise<string>;

const objectUrls = new Map<string, CacheEntry>();

export const tauriMediaObjectUrlTestHooks = {
  clear(): void {
    objectUrls.forEach((entry) => {
      if (typeof entry === 'string') URL.revokeObjectURL(entry);
    });
    objectUrls.clear();
  },
};

function remember(url: string, objectUrl: string): void {
  objectUrls.delete(url);
  objectUrls.set(url, objectUrl);
  while (objectUrls.size > MAX_ENTRIES) {
    const oldestKey = objectUrls.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = objectUrls.get(oldestKey);
    objectUrls.delete(oldestKey);
    if (typeof oldest === 'string') URL.revokeObjectURL(oldest);
  }
}

export function getTauriMediaObjectUrl(url: string): string | undefined {
  const entry = objectUrls.get(url);
  if (typeof entry !== 'string') return undefined;
  remember(url, entry);
  return entry;
}

async function ensureTauriMediaObjectUrl(url: string): Promise<string> {
  const existing = objectUrls.get(url);
  if (existing !== undefined) return existing;

  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`media fetch failed: ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      remember(url, objectUrl);
      return objectUrl;
    })
    .catch((err) => {
      if (objectUrls.get(url) === request) objectUrls.delete(url);
      throw err;
    });
  objectUrls.set(url, request);
  return request;
}

/**
 * Resolves `src` to a session-cached blob object URL on Tauri, where the media scheme
 * bypasses the webview's HTTP cache. Falls back to the raw URL on fetch failure.
 * Pass-through outside Tauri, where the service worker caches media.
 */
export const useTauriMediaObjectUrl = (src: string | undefined): string | undefined => {
  const active = isTauri() && src !== undefined;
  const [resolved, setResolved] = useState<string | undefined>(() =>
    active ? (getTauriMediaObjectUrl(src) ?? undefined) : src
  );

  useEffect(() => {
    if (!active) {
      setResolved(src);
      return undefined;
    }

    let cancelled = false;
    const cached = getTauriMediaObjectUrl(src);
    if (cached !== undefined) {
      setResolved(cached);
      return undefined;
    }

    setResolved(undefined);
    ensureTauriMediaObjectUrl(src).then(
      (objectUrl) => {
        if (!cancelled) setResolved(objectUrl);
      },
      () => {
        if (!cancelled) setResolved(src);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [active, src]);

  return active ? resolved : src;
};
