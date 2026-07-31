import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '$state/sessions';
import type * as PlatformModule from '$utils/platform';
import { ACTIVE_SESSION_KEY, MATRIX_SESSIONS_KEY } from '$state/sessions';

const { isMobileTauri } = vi.hoisted(() => ({
  isMobileTauri: vi.fn<() => boolean>(),
}));

vi.mock('$utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformModule>()),
  isMobileTauri,
}));

import { ownsActiveMediaSession, resolvePollTimeoutMs } from './initMatrix';

const alice = { userId: '@alice:example.org' } as Session;
const bob = { userId: '@bob:example.org' } as Session;

describe('ownsActiveMediaSession', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(MATRIX_SESSIONS_KEY, JSON.stringify([alice, bob]));
  });

  it('keeps Alice media session while logging out secondary Bob', () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(alice.userId));

    expect(ownsActiveMediaSession(bob)).toBe(false);
  });

  it('clears the active account media session', () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(alice.userId));

    expect(ownsActiveMediaSession(alice)).toBe(true);
  });
});

describe('resolvePollTimeoutMs', () => {
  beforeEach(() => {
    isMobileTauri.mockReset();
  });

  it('uses the shorter poll on mobile tauri', () => {
    isMobileTauri.mockReturnValue(true);

    expect(resolvePollTimeoutMs(undefined)).toBe(30000);
  });

  it('uses the default poll elsewhere', () => {
    isMobileTauri.mockReturnValue(false);

    expect(resolvePollTimeoutMs(undefined)).toBe(45000);
  });

  it('prefers an explicitly configured timeout on mobile', () => {
    isMobileTauri.mockReturnValue(true);

    expect(resolvePollTimeoutMs(5000)).toBe(5000);
  });
});
