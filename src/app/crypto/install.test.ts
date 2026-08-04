import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { LegacyWasmCryptoStoreError, rustEngineEnabled } from './install';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn<() => boolean>() }));

vi.mock('$generated/tauri/commands', () => ({
  engineOpen: vi.fn<(...args: never[]) => unknown>(),
}));

const mockIsTauri = vi.mocked(isTauri);

describe('rustEngineEnabled', () => {
  beforeEach(() => {
    mockIsTauri.mockReset();
  });

  it('keeps WASM crypto for non-Tauri clients', async () => {
    mockIsTauri.mockReturnValue(false);

    await expect(rustEngineEnabled('sync@alice:example.org')).resolves.toBe(false);
  });

  it('enables the native engine when no legacy crypto store exists', async () => {
    mockIsTauri.mockReturnValue(true);
    const databases = vi.fn<() => Promise<IDBDatabaseInfo[]>>().mockResolvedValue([]);
    vi.stubGlobal('indexedDB', { databases });

    await expect(rustEngineEnabled('sync@alice:example.org')).resolves.toBe(true);
    expect(databases).toHaveBeenCalledOnce();
  });

  it('requires re-authentication instead of retaining a legacy WASM engine', async () => {
    mockIsTauri.mockReturnValue(true);
    vi.stubGlobal('indexedDB', {
      databases: vi
        .fn<() => Promise<IDBDatabaseInfo[]>>()
        .mockResolvedValue([{ name: 'sync@alice:example.org::matrix-sdk-crypto' }]),
    });

    await expect(rustEngineEnabled('sync@alice:example.org')).rejects.toBeInstanceOf(
      LegacyWasmCryptoStoreError
    );
  });

  it('requires re-authentication when the legacy store cannot be inspected safely', async () => {
    mockIsTauri.mockReturnValue(true);
    vi.stubGlobal('indexedDB', {});

    await expect(rustEngineEnabled('sync@alice:example.org')).rejects.toBeInstanceOf(
      LegacyWasmCryptoStoreError
    );
  });
});
