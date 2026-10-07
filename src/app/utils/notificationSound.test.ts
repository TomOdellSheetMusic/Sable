import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  playNotificationSound as PlayNotificationSound,
  shouldPlayBundledSound as ShouldPlayBundledSound,
} from './notificationSound';

let playNotificationSound: typeof PlayNotificationSound;
let shouldPlayBundledSound: typeof ShouldPlayBundledSound;

type MockSource = {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  ended: (() => void) | undefined;
};

const nativeAudioContext = globalThis.AudioContext;
const nativeFetch = globalThis.fetch;
let sources: MockSource[];
let audioContexts: MockAudioContext[];
let failToStartAudioDevice = false;

class MockAudioContext {
  public state: AudioContextState = 'running';
  public destination = {} as AudioDestinationNode;

  public decodeAudioData = vi.fn<() => Promise<AudioBuffer>>().mockResolvedValue({} as AudioBuffer);
  public resume = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  public close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  public createBufferSource = vi.fn<() => AudioBufferSourceNode>(() => {
    const source: MockSource = {
      buffer: null,
      connect: vi.fn<() => void>(),
      disconnect: vi.fn<() => void>(),
      start: vi.fn<() => void>(() => {
        if (failToStartAudioDevice) {
          failToStartAudioDevice = false;
          throw new DOMException('Failed to start the audio device', 'InvalidStateError');
        }
      }),
      addEventListener: vi.fn<(type: string, listener: () => void) => void>((type, listener) => {
        if (type === 'ended') source.ended = listener;
      }),
      ended: undefined,
    };
    sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });

  public constructor() {
    audioContexts.push(this);
  }
}

beforeEach(async () => {
  vi.resetModules();
  ({ playNotificationSound, shouldPlayBundledSound } = await import('./notificationSound'));
  sources = [];
  audioContexts = [];
  failToStartAudioDevice = false;
  globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
  globalThis.fetch = vi.fn<() => Promise<Response>>().mockResolvedValue({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as Response);
});

afterEach(() => {
  globalThis.AudioContext = nativeAudioContext;
  globalThis.fetch = nativeFetch;
});

describe('playNotificationSound', () => {
  it('does not overlap sounds requested while one is playing', async () => {
    await Promise.all([
      playNotificationSound('/sound/notification.ogg'),
      playNotificationSound('/sound/notification.ogg'),
    ]);

    expect(sources).toHaveLength(1);

    sources[0]!.ended?.();
    await playNotificationSound('/sound/notification.ogg');

    expect(sources).toHaveLength(2);
    sources[1]!.ended?.();
  });

  it('recovers after the audio device rejects a buffer source', async () => {
    failToStartAudioDevice = true;

    await expect(playNotificationSound('/sound/notification.ogg')).rejects.toMatchObject({
      name: 'InvalidStateError',
      message: 'Failed to start the audio device',
    });

    await playNotificationSound('/sound/notification.ogg');

    expect(audioContexts).toHaveLength(2);
    expect(sources).toHaveLength(2);
    expect(audioContexts[0]!.close).toHaveBeenCalledOnce();
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce();
  });
});

describe('shouldPlayBundledSound', () => {
  it('plays the first notification from a source', () => {
    expect(shouldPlayBundledSound('!room:example.org')).toBe(true);
  });

  it('bundles (silences) subsequent notifications from the same source within the window', () => {
    expect(shouldPlayBundledSound('!room:example.org')).toBe(true);
    expect(shouldPlayBundledSound('!room:example.org')).toBe(false);
    expect(shouldPlayBundledSound('!room:example.org')).toBe(false);
  });

  it('does not bundle notifications from different sources', () => {
    expect(shouldPlayBundledSound('!roomA:example.org')).toBe(true);
    expect(shouldPlayBundledSound('!roomB:example.org')).toBe(true);
    expect(shouldPlayBundledSound('!roomA:example.org')).toBe(false);
    expect(shouldPlayBundledSound('!roomB:example.org')).toBe(false);
  });

  it('allows a source to play again after the bundling window elapses', () => {
    vi.useFakeTimers();
    try {
      expect(shouldPlayBundledSound('!room:example.org')).toBe(true);
      expect(shouldPlayBundledSound('!room:example.org')).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(shouldPlayBundledSound('!room:example.org')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the bundling window while a source keeps sending notifications', () => {
    vi.useFakeTimers();
    try {
      expect(shouldPlayBundledSound('!room:example.org')).toBe(true);

      // A sustained burst: each notification refreshes the window, so the sound
      // stays silenced even past the initial 1500ms window.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1000);
        expect(shouldPlayBundledSound('!room:example.org')).toBe(false);
      }

      // Once the source goes quiet for the full window, it can alert again.
      vi.advanceTimersByTime(2000);
      expect(shouldPlayBundledSound('!room:example.org')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
