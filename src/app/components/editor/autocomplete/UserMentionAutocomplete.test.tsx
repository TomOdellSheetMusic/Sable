import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room, RoomMember } from '$types/matrix-sdk';
import type {
  EditorAutocompleteQuery,
  ProseMirrorEditorController,
} from '../prosemirrorController';

const mocks = vi.hoisted(() => ({
  mx: {
    getUserId: vi.fn<() => string | null>().mockReturnValue('@me:example.org'),
    searchUserDirectory: vi.fn<MatrixClient['searchUserDirectory']>(),
  },
  resetSearch: vi.fn<() => void>(),
  search: vi.fn<(query: string) => void>(),
}));

vi.mock('$hooks/useMatrixClient', () => ({ useMatrixClient: () => mocks.mx }));
vi.mock('$hooks/useMediaAuthentication', () => ({ useMediaAuthentication: () => false }));
vi.mock('$hooks/useRoomMembers', () => ({ useRoomMembers: () => [] as RoomMember[] }));
vi.mock('$hooks/useAsyncSearch', () => ({
  useAsyncSearch: () => [undefined, mocks.search, mocks.resetSearch],
}));
vi.mock('$hooks/useKeyDown', () => ({ useKeyDown: () => undefined }));

import { UserMentionAutocomplete } from './UserMentionAutocomplete';

const room = {
  roomId: '!room:example.org',
  getCanonicalAlias: () => undefined,
  getMember: () => undefined,
  membersLoaded: () => false,
} as unknown as Room;
const query: EditorAutocompleteQuery<string> = {
  from: 1,
  prefix: '@',
  text: 'alice',
  to: 6,
};

describe('UserMentionAutocomplete', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('offers unloaded users from the global directory', async () => {
    vi.useFakeTimers();
    mocks.mx.searchUserDirectory.mockResolvedValue({
      limited: false,
      results: [{ user_id: '@alice:example.org', display_name: 'Alice' }],
    });
    const controller = {
      insertInline: vi.fn<(node: unknown, from: number, to: number) => void>(),
      insertText: vi.fn<(text: string) => void>(),
    } as unknown as ProseMirrorEditorController;
    const requestClose = vi.fn<() => void>();

    render(
      <UserMentionAutocomplete
        room={room}
        controller={controller}
        query={query}
        requestClose={requestClose}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mocks.mx.searchUserDirectory).toHaveBeenCalledWith({ term: 'alice', limit: 20 });
    fireEvent.click(screen.getByText('Alice'));
    expect(controller.insertInline).toHaveBeenCalledOnce();
    expect(controller.insertText).toHaveBeenCalledWith(' ');
    expect(requestClose).toHaveBeenCalledOnce();
  });
});
