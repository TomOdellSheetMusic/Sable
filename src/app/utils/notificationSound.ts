// HTMLAudioElement.play() registers a media session (lock screen / media keys)
// and, in WKWebView, runs on the .playback audio session category, which uses
// media volume and interrupts whatever the user is listening to. A Web Audio
// buffer source does neither.

let context: AudioContext | undefined;
let playingSource: AudioBufferSourceNode | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

// Bundling: when many notifications arrive from the same source in quick
// succession (e.g. a bridge backfilling a freshly-created room), we only want
// to play the sound once. Each source records the last time a sound was played
// for it; subsequent notifications within the window are silenced.
const sourceCooldowns = new Map<string, number>();
const BUNDLE_WINDOW_MS = 2000;

/**
 * Returns true if a sound should play for the given source, and records the
 * play time. When multiple notifications arrive from the same source within
 * the bundling window, only the first one plays a sound — the rest are bundled
 * (silenced). The window is refreshed on every notification, so a source that
 * keeps sending messages (e.g. a bridge backfilling a room) stays silenced for
 * as long as the messages keep coming. This prevents notification-sound spam
 * during bridge backfills.
 */
export const shouldPlayBundledSound = (source: string): boolean => {
  const now = Date.now();
  const lastPlayed = sourceCooldowns.get(source);
  // Always refresh the cooldown so the window slides forward while the source
  // keeps producing notifications — a sustained burst stays bundled rather than
  // re-alerting once the initial window elapses.
  sourceCooldowns.set(source, now);
  if (lastPlayed !== undefined && now - lastPlayed < BUNDLE_WINDOW_MS) {
    return false;
  }
  return true;
};

const decode = (ctx: AudioContext, url: string): Promise<AudioBuffer> => {
  const cached = buffers.get(url);
  if (cached) return cached;

  const buffer = fetch(url)
    .then((response) => response.arrayBuffer())
    .then((bytes) => ctx.decodeAudioData(bytes))
    .catch((error) => {
      buffers.delete(url);
      throw error;
    });
  buffers.set(url, buffer);
  return buffer;
};

const resetAudioState = (
  failedContext: AudioContext,
  failedSource?: AudioBufferSourceNode
): void => {
  if (context === failedContext) {
    context = undefined;
    playingSource = undefined;
    buffers.clear();
  }
  failedSource?.disconnect();
  if (failedContext.state !== 'closed') {
    void failedContext.close().catch(() => {});
  }
};

export const playNotificationSound = async (url: string): Promise<void> => {
  const audioContext = (context ??= new AudioContext());
  const buffer = await decode(audioContext, url);
  let source: AudioBufferSourceNode | undefined;
  try {
    if (context !== audioContext) return;
    if (audioContext.state !== 'running') {
      await audioContext.resume();
      if (context !== audioContext) return;
    }
    if (playingSource) return;
    source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    playingSource = source;
    source.addEventListener(
      'ended',
      () => {
        if (playingSource === source) playingSource = undefined;
      },
      { once: true }
    );
    source.start();
  } catch (error) {
    resetAudioState(audioContext, source);
    throw error;
  }
};
