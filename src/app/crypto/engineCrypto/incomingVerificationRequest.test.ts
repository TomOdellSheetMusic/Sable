import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoEvent, EventType, type MatrixClient } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const clientSpy = () => {
  const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async () => '{}');
  return { mx: { http: { authedRequest } } as unknown as MatrixClient, authedRequest };
};

const REQUEST_EVENT = {
  type: EventType.KeyVerificationRequest,
  sender: '@me:e.org',
  content: { transaction_id: '$f', from_device: 'OTHER' },
};

const requestState = {
  flowId: '$f',
  otherUserId: '@me:e.org',
  phase: 1,
  isSelfVerification: true,
};

describe('pending verification request sweep', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('surfaces a request the engine holds but the sync path never delivered', async () => {
    const { mx } = clientSpy();
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'getVerificationRequests') return [requestState];
      return [];
    });

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    const received = vi.fn<(request: unknown) => void>();
    crypto.on(CryptoEvent.VerificationRequestReceived, received);

    crypto.onSyncCompleted({} as never);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  });

  it('does not surface the same request twice', async () => {
    const { mx } = clientSpy();
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'receiveSyncChanges') {
        return [{ type: 3, rawEvent: JSON.stringify(REQUEST_EVENT) }];
      }
      if (method === 'getVerificationRequest') return requestState;
      if (method === 'getVerificationRequests') return [requestState];
      return [];
    });

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    const received = vi.fn<(request: unknown) => void>();
    crypto.on(CryptoEvent.VerificationRequestReceived, received);

    await crypto.preprocessToDeviceMessages([REQUEST_EVENT as never]);
    crypto.onSyncCompleted({} as never);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  });
});

describe('outgoing device verification request', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('refreshes the target user keys before asking the engine for the device', async () => {
    const { mx } = clientSpy();
    const invoked: string[] = [];

    mockInvoke.mockImplementation(async (_identity, method) => {
      invoked.push(method as string);
      if (method === 'queryKeysForUsers') {
        return { id: 'q1', type: 1, className: 'KeysQueryRequest', body: '{}' };
      }
      if (method === 'device.requestVerification') {
        return { request: { ...requestState, phase: 0 }, outgoingRequest: null };
      }
      return [];
    });

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    await crypto.requestDeviceVerification('@me:e.org', 'OTHER');

    expect(invoked.indexOf('queryKeysForUsers')).toBeGreaterThanOrEqual(0);
    expect(invoked.indexOf('queryKeysForUsers')).toBeLessThan(
      invoked.indexOf('device.requestVerification')
    );
  });
});

describe('incoming verification request', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('fetches the sender keys and replays the event when the device is unknown', async () => {
    const { mx } = clientSpy();
    let senderKnown = false;
    const invoked: string[] = [];

    mockInvoke.mockImplementation(async (_identity, method) => {
      invoked.push(method as string);
      if (method === 'receiveSyncChanges') {
        return [{ type: 3, rawEvent: JSON.stringify(REQUEST_EVENT) }];
      }
      if (method === 'queryKeysForUsers') {
        senderKnown = true;
        return { id: 'q1', type: 1, className: 'KeysQueryRequest', body: '{}' };
      }
      if (method === 'getVerificationRequest') return senderKnown ? requestState : null;
      return [];
    });

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    const received = vi.fn<(request: unknown) => void>();
    crypto.on(CryptoEvent.VerificationRequestReceived, received);

    await crypto.preprocessToDeviceMessages([REQUEST_EVENT as never]);

    expect(invoked.filter((m) => m === 'queryKeysForUsers')).toHaveLength(1);
    expect(invoked.filter((m) => m === 'receiveSyncChanges')).toHaveLength(2);
    expect(received).toHaveBeenCalledOnce();
  });

  it('does not replay when the engine already knows the request', async () => {
    const { mx } = clientSpy();
    const invoked: string[] = [];

    mockInvoke.mockImplementation(async (_identity, method) => {
      invoked.push(method as string);
      if (method === 'receiveSyncChanges') {
        return [{ type: 3, rawEvent: JSON.stringify(REQUEST_EVENT) }];
      }
      if (method === 'getVerificationRequest') return requestState;
      return [];
    });

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    const received = vi.fn<(request: unknown) => void>();
    crypto.on(CryptoEvent.VerificationRequestReceived, received);

    await crypto.preprocessToDeviceMessages([REQUEST_EVENT as never]);

    expect(invoked).not.toContain('queryKeysForUsers');
    expect(invoked.filter((m) => m === 'receiveSyncChanges')).toHaveLength(1);
    expect(received).toHaveBeenCalledOnce();
  });
});
