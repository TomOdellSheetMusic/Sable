import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Scroll, Text, config } from 'folds';
import { PageContent, SettingsSectionPage } from '$components/page';
import { SequenceCard, SequenceCardStyle } from '$components/sequence-card';
import { SettingTile } from '$components/setting-tile';
import { useSetting } from '$state/hooks/settings';
import { settingsAtom } from '$state/settings';
import { useDesktopSetting } from '$state/hooks/desktopSettings';
import { isDesktopTauri } from '$utils/platform';
import {
  SHORTCUTS,
  captureShortcut,
  findShortcutConflict,
  formatShortcut,
  fromAccelerator,
  getShortcutBinding,
  toAccelerator,
} from '../../../keyboard/shortcuts';
import type { ShortcutDefinition, ShortcutId } from '../../../keyboard/shortcuts';

const CATEGORIES = ['General', 'Navigation', 'Messages'] as const;

function ShortcutKeys({ binding }: { binding: string | null }) {
  const label = formatShortcut(binding);
  return (
    <kbd
      style={{
        fontFamily: 'monospace',
        fontWeight: 'bold',
        padding: `0 ${config.space.S100}`,
        borderRadius: '3px',
        border: '1px solid currentColor',
        opacity: binding === null ? 0.6 : 0.8,
        fontSize: '0.85em',
      }}
    >
      {label}
    </kbd>
  );
}

type ShortcutRowProps = {
  shortcut: ShortcutDefinition;
  binding: string | null;
  customized: boolean;
  editing: boolean;
  error?: string;
  onEdit: () => void;
  onReset: () => void;
};

function ShortcutRow({
  shortcut,
  binding,
  customized,
  editing,
  error,
  onEdit,
  onReset,
}: ShortcutRowProps) {
  return (
    <SettingTile
      title={shortcut.label}
      focusId={`shortcut-${shortcut.id}`}
      showSettingLinkAction={false}
      description={
        editing && !error ? 'Press a shortcut. Backspace removes it; Escape cancels.' : undefined
      }
      after={
        <Box alignItems="Center" gap="200" wrap="Wrap">
          <ShortcutKeys binding={binding} />
          <Button
            variant="Secondary"
            fill="Soft"
            outlined
            size="300"
            radii="300"
            onClick={onEdit}
            aria-label={
              editing ? `Press a new shortcut for ${shortcut.label}` : `Change ${shortcut.label}`
            }
          >
            <Text size="B300">{editing ? 'Press keys…' : 'Change'}</Text>
          </Button>
          {customized && (
            <Button
              variant="Critical"
              fill="Soft"
              outlined
              size="300"
              radii="300"
              onClick={onReset}
            >
              <Text size="B300">Reset</Text>
            </Button>
          )}
        </Box>
      }
    >
      {editing && error && (
        <Text size="T200" priority="500" aria-live="polite">
          {error}
        </Text>
      )}
    </SettingTile>
  );
}

type CallGlobalShortcutRowProps = {
  title: string;
  description: string;
  binding: string | null;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onReset: () => void;
};

function CallGlobalShortcutRow({
  title,
  description,
  binding,
  editing,
  onEdit,
  onCancel,
  onReset,
}: CallGlobalShortcutRowProps) {
  return (
    <SettingTile
      title={title}
      focusId={`call-shortcut-${title}`}
      showSettingLinkAction={false}
      description={
        editing ? 'Press a shortcut. Backspace removes it; Escape cancels.' : description
      }
      after={
        <Box alignItems="Center" gap="200" wrap="Wrap">
          <ShortcutKeys binding={fromAccelerator(binding)} />
          <Button
            variant="Secondary"
            fill="Soft"
            outlined
            size="300"
            radii="300"
            onClick={editing ? onCancel : onEdit}
            aria-label={editing ? `Press a new shortcut for ${title}` : `Change ${title}`}
          >
            <Text size="B300">{editing ? 'Press keys…' : 'Change'}</Text>
          </Button>
          {binding !== null && (
            <Button
              variant="Critical"
              fill="Soft"
              outlined
              size="300"
              radii="300"
              onClick={onReset}
            >
              <Text size="B300">Reset</Text>
            </Button>
          )}
        </Box>
      }
    >
      {editing && (
        <Text size="T200" priority="500" aria-live="polite">
          Press a shortcut. Backspace removes it; Escape cancels.
        </Text>
      )}
    </SettingTile>
  );
}

type KeyboardShortcutsProps = {
  requestBack?: () => void;
  requestClose: () => void;
};

export function KeyboardShortcuts({ requestBack, requestClose }: KeyboardShortcutsProps) {
  const [micHotkey, setMicHotkey] = useDesktopSetting('micHotkey');
  const [deafenHotkey, setDeafenHotkey] = useDesktopSetting('deafenHotkey');
  const [editingCallHotkey, setEditingCallHotkey] = useState<'mic' | 'deafen' | undefined>();

  const handleCallShortcutCapture = useCallback(
    (event: KeyboardEvent) => {
      if (!editingCallHotkey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setEditingCallHotkey(undefined);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (editingCallHotkey === 'mic') setMicHotkey(null);
        else setDeafenHotkey(null);
        setEditingCallHotkey(undefined);
        return;
      }
      const captured = captureShortcut(event);
      if (!captured) return;
      if (editingCallHotkey === 'mic') setMicHotkey(toAccelerator(captured));
      else setDeafenHotkey(toAccelerator(captured));
      setEditingCallHotkey(undefined);
    },
    [editingCallHotkey, setMicHotkey, setDeafenHotkey]
  );

  useEffect(() => {
    if (!editingCallHotkey) return undefined;
    window.addEventListener('keydown', handleCallShortcutCapture, true);
    return () => window.removeEventListener('keydown', handleCallShortcutCapture, true);
  }, [editingCallHotkey, handleCallShortcutCapture]);

  const [overrides, setOverrides] = useSetting(settingsAtom, 'shortcutOverrides');
  const [editingId, setEditingId] = useState<ShortcutId>();
  const [error, setError] = useState<string>();

  const updateOverride = useCallback(
    (id: ShortcutId, binding: string | null | undefined) => {
      setOverrides((current) => {
        const next = { ...current };
        if (binding === undefined) delete next[id];
        else next[id] = binding;
        return next;
      });
      setEditingId(undefined);
      setError(undefined);
    },
    [setOverrides]
  );

  useEffect(() => {
    const id = editingId;
    if (!id) return undefined;

    const handleCapture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setEditingId(undefined);
        setError(undefined);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        updateOverride(id, null);
        return;
      }
      const binding = captureShortcut(event);
      if (!binding) return;
      const conflict = findShortcutConflict(id, binding, overrides);
      if (conflict) {
        setError(`Already used by “${conflict.label}” in this context.`);
        return;
      }
      updateOverride(id, binding);
    };

    window.addEventListener('keydown', handleCapture, true);
    return () => window.removeEventListener('keydown', handleCapture, true);
  }, [editingId, overrides, updateOverride]);

  return (
    <SettingsSectionPage
      title="Keyboard Shortcuts"
      titleAs="h1"
      actionLabel="Close keyboard shortcuts"
      requestBack={requestBack}
      requestClose={requestClose}
    >
      <Box grow="Yes">
        <Scroll hideTrack visibility="Hover">
          <PageContent>
            <Box direction="Column" gap="600">
              <Text size="T300" priority="300">
                Choose Change, then press a new key combination. Global shortcuts do not run while
                typing unless the action specifically supports it.
              </Text>
              {CATEGORIES.map((category) => (
                <Box key={category} direction="Column" gap="100">
                  <Text size="L400" as="h2">
                    {category}
                  </Text>
                  <Box direction="Column" gap="100">
                    {SHORTCUTS.filter((shortcut) => shortcut.category === category).map(
                      (shortcut) => (
                        <SequenceCard
                          key={shortcut.id}
                          className={SequenceCardStyle}
                          variant="SurfaceVariant"
                          direction="Column"
                        >
                          <ShortcutRow
                            shortcut={shortcut}
                            binding={getShortcutBinding(shortcut.id, overrides)}
                            customized={shortcut.id in overrides}
                            editing={editingId === shortcut.id}
                            error={editingId === shortcut.id ? error : undefined}
                            onEdit={() => {
                              setEditingId(shortcut.id);
                              setError(undefined);
                            }}
                            onReset={() => updateOverride(shortcut.id, undefined)}
                          />
                        </SequenceCard>
                      )
                    )}
                  </Box>
                </Box>
              ))}
              {isDesktopTauri() && (
                <Box direction="Column" gap="100">
                  <Text size="L400" as="h2">
                    Call
                  </Text>
                  <Box direction="Column" gap="100">
                    <SequenceCard
                      className={SequenceCardStyle}
                      variant="SurfaceVariant"
                      direction="Column"
                    >
                      <CallGlobalShortcutRow
                        title="Toggle microphone"
                        description="Mute or unmute the microphone during a call, even when Sable isn't focused."
                        binding={micHotkey}
                        editing={editingCallHotkey === 'mic'}
                        onEdit={() => setEditingCallHotkey('mic')}
                        onCancel={() => setEditingCallHotkey(undefined)}
                        onReset={() => setMicHotkey(null)}
                      />
                    </SequenceCard>
                    <SequenceCard
                      className={SequenceCardStyle}
                      variant="SurfaceVariant"
                      direction="Column"
                    >
                      <CallGlobalShortcutRow
                        title="Deafen"
                        description="Mute everything (output and microphone) during a call, even when Sable isn't focused."
                        binding={deafenHotkey}
                        editing={editingCallHotkey === 'deafen'}
                        onEdit={() => setEditingCallHotkey('deafen')}
                        onCancel={() => setEditingCallHotkey(undefined)}
                        onReset={() => setDeafenHotkey(null)}
                      />
                    </SequenceCard>
                  </Box>
                </Box>
              )}
            </Box>
          </PageContent>
        </Scroll>
      </Box>
    </SettingsSectionPage>
  );
}
