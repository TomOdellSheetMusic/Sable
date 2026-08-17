import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UserEvent } from '$types/matrix-sdk';
import { MatrixClientProvider } from './useMatrixClient';
import { useUserPresence } from './useUserPresence';

const makeClient = () => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let currentUser: any;

  const mx = {
    getUser: vi.fn((userId: string) => (userId === '@alice:example.org' ? currentUser : null)),
    getUserId: vi.fn(() => '@me:example.org'),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: (event: string, ...args: any[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };

  return {
    mx,
    setUser: (user: any) => {
      currentUser = user;
    },
  };
};

describe('useUserPresence', () => {
  it('updates when a presence event arrives before the user exists in the store', () => {
    const { mx, setUser } = makeClient();

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MatrixClientProvider, { value: mx }, children);

    const { result } = renderHook(() => useUserPresence('@alice:example.org'), { wrapper });

    expect(result.current).toBeUndefined();

    act(() => {
      setUser({
        userId: '@alice:example.org',
        presence: 'online',
        presenceStatusMsg: 'Hello there',
        currentlyActive: true,
        getLastActiveTs: () => 123,
      });

      mx.emit(UserEvent.Presence);
    });

    expect(result.current).toEqual({
      presence: 'online',
      status: 'Hello there',
      active: true,
      lastActiveTs: 123,
    });
  });
});
