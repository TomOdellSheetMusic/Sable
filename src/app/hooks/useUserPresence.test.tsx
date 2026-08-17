import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UserEvent } from '$types/matrix-sdk';
import type { MatrixClient, User } from '$types/matrix-sdk';
import { MatrixClientProvider } from './useMatrixClient';
import { useUserPresence } from './useUserPresence';

type Listener = (...args: unknown[]) => void;

const makeClient = () => {
  const listeners = new Map<string, Set<Listener>>();
  let currentUser: User | undefined;

  const mx = {
    getUser: vi.fn<(userId: string) => User | null>((userId: string) =>
      userId === '@alice:example.org' ? (currentUser ?? null) : null
    ),
    getUserId: vi.fn<() => string>(() => '@me:example.org'),
    on: vi.fn<(event: string, listener: Listener) => void>((event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    removeListener: vi.fn<(event: string, listener: Listener) => void>((event, listener) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: vi.fn<(event: string, ...args: never[]) => void>((event, ...args) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    }),
  } as unknown as MatrixClient;

  return {
    mx,
    setUser: (user: User) => {
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
      } as unknown as User);

      mx.emit(UserEvent.Presence, undefined, {} as User);
    });

    expect(result.current).toEqual({
      presence: 'online',
      status: 'Hello there',
      active: true,
      lastActiveTs: 123,
    });
  });
});
