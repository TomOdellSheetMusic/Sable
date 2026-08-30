import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Method } from 'matrix-js-sdk/lib/http-api';
import type { MatrixClient } from '$types/matrix-sdk';
import { RequestType, sendOutgoingRequest } from './outgoing';

vi.mock('matrix-js-sdk/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('matrix-js-sdk/lib/utils')>()),
  sleep: vi.fn(async () => undefined),
}));

const rateLimited = () =>
  Object.assign(new Error('rate limited'), {
    httpStatus: 429,
    data: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 10 },
  });

const request = { id: 'r1', type: RequestType.KeysClaim, body: '{}' };

describe('sendOutgoingRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries a rate-limited request instead of failing the caller', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce('{}');
    const mx = { http: { authedRequest } } as unknown as MatrixClient;

    await expect(sendOutgoingRequest(mx, request)).resolves.toBe('{}');
    expect(authedRequest).toHaveBeenCalledTimes(2);
    expect(authedRequest.mock.calls[0]?.[0]).toBe(Method.Post);
  });

  it('rethrows an error that is not worth retrying', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('nope'), { httpStatus: 400, data: {} }));
    const mx = { http: { authedRequest } } as unknown as MatrixClient;

    await expect(sendOutgoingRequest(mx, request)).rejects.toThrow('nope');
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });
});
