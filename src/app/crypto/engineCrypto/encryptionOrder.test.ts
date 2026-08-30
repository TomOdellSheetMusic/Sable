import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({ engineInvoke: vi.fn() }));

const mockInvoke = vi.mocked(engineInvoke);

const room = (roomId: string) =>
  ({
    roomId,
    getEncryptionTargetMembers: async () => [{ userId: '@me:e.org' }],
    getHistoryVisibility: () => 'shared',
    getBlacklistUnverifiedDevices: () => false,
    currentState: { getStateEvents: () => null },
  }) as unknown as Room;

const event = () =>
  ({
    getType: () => 'm.room.message',
    getContent: () => ({}),
    makeEncrypted: vi.fn(),
    getTxnId: () => 't',
  }) as unknown as MatrixEvent;

describe('encryptEvent ordering', () => {
  it('never runs two encryptions for a room at the same time', async () => {
    const marks: string[] = [];
    let inFlight = 0;

    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'encryptRoomEvent') {
        inFlight += 1;
        marks.push(`enter${inFlight}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        inFlight -= 1;
        marks.push('exit');
        return '{}';
      }
      if (method === 'identityKeys') return { ed25519: 'e', curve25519: 'c' };
      return null;
    });

    const mx = { http: { authedRequest: vi.fn() } } as unknown as MatrixClient;
    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });

    await Promise.all([
      crypto.encryptEvent(event(), room('!r:e.org')),
      crypto.encryptEvent(event(), room('!r:e.org')),
    ]);

    expect(marks).toEqual(['enter1', 'exit', 'enter1', 'exit']);
  });
});
