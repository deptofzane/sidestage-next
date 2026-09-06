'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureOk } from '@/lib/api';
import { useCanGoBack } from '../../../NavigationHistoryProvider';
import { ConfirmModal } from '../../../ConfirmModal';
import { useTrackPending } from '../../../PendingActionProvider';
import { useToast } from '../../../ToastProvider';
import { Spinner } from '../../../Spinner';
import {
  SetlistItemsEditor,
  type SetlistItem,
  type SetlistPoolSong,
} from '../setlists/SetlistItemsEditor';
import { AlbumVersionPicker } from './AlbumVersionPicker';

/** A track being edited: a song, plus the version it's pinned to. */
export interface AlbumEditorTrack extends SetlistItem {
  conversationId: string;
  /** Pinned version id, or null to follow the song's default. */
  audioVersionId: string | null;
  /** What the pin was called, for the row's caption. */
  pinnedLabel: string | null;
  pinnedFileName: string | null;
  /** True when the pinned version has since been deleted. */
  lost: boolean;
}

const inputCls =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

/**
 * The shared body of the New and Edit album screens.
 *
 * Reuses `SetlistItemsEditor` rather than reimplementing drag-reorder and the
 * add-songs modal — it's already parameterised, and this passes three options
 * that make it album-shaped: no markers (a record has no set break), duplicates
 * allowed (the same song can appear twice on different takes), and a per-row
 * control for the version pin.
 */
export function AlbumEditor({
  bandId,
  albumId,
  initialName,
  initialTracks,
  songPool,
}: {
  bandId: string;
  /** Null on the New screen — the album doesn't exist until the first save. */
  albumId: string | null;
  initialName: string;
  initialTracks: AlbumEditorTrack[];
  songPool: SetlistPoolSong[];
}) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const trackPending = useTrackPending();
  const showToast = useToast();

  const [name, setName] = useState(initialName);
  const [items, setItems] = useState<SetlistItem[]>(initialTracks);
  const [busy, setBusy] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  // Row whose version picker is open.
  const [picking, setPicking] = useState<AlbumEditorTrack | null>(null);

  // `SetlistItemsEditor` builds newly-added rows with only id/conversationId/
  // name — it knows nothing about pins — so every row is read through this
  // rather than cast. A cast would leave `audioVersionId` undefined on exactly
  // the rows the user just added, which is the case most likely to be saved.
  const asTrack = (row: SetlistItem): AlbumEditorTrack => ({
    audioVersionId: null,
    pinnedLabel: null,
    pinnedFileName: null,
    lost: false,
    ...(row as Partial<AlbumEditorTrack>),
    id: row.id,
    conversationId: row.conversationId!,
    name: row.name,
    originalArtist: row.originalArtist,
  });

  const tracks = items.map(asTrack);
  const nameTrim = name.trim();
  const dirty =
    nameTrim !== initialName ||
    JSON.stringify(tracks.map((t) => [t.conversationId, t.audioVersionId])) !==
      JSON.stringify(
        initialTracks.map((t) => [t.conversationId, t.audioVersionId]),
      );
  const canSave = nameTrim !== '' && !busy;

  const leave = () => {
    if (albumId) router.replace(`/bands/${bandId}/albums/${albumId}`);
    else if (canGoBack()) router.back();
    else router.replace(`/bands/${bandId}/audio?tab=songs`);
  };

  const setVersion = (
    rowId: string,
    version: { id: string; label: string | null; fileName: string } | null,
  ) => {
    setItems((prev) =>
      prev.map((row) => {
        if (row.id !== rowId) return row;
        // The snapshot is re-taken server-side on save; these fields are what
        // captions the row in the meantime, so they carry the picked version's
        // own name rather than whatever was there before.
        return {
          ...asTrack(row),
          audioVersionId: version?.id ?? null,
          pinnedLabel: version?.label ?? null,
          pinnedFileName: version?.fileName ?? null,
          lost: false,
        };
      }),
    );
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const payload = {
      name: nameTrim,
      tracks: tracks.map((t) => ({
        conversationId: t.conversationId,
        audioVersionId: t.audioVersionId,
      })),
    };
    try {
      const id = await trackPending(async () => {
        if (albumId) {
          const res = await fetch(`/api/bands/${bandId}/albums/${albumId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          await ensureOk(res);
          return albumId;
        }
        const res = await fetch(`/api/bands/${bandId}/albums`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        await ensureOk(res, [201]);
        return ((await res.json()) as { albumId: string }).albumId;
      });
      showToast(albumId ? 'Album saved.' : 'Album created.', 'success');
      router.refresh();
      router.replace(`/bands/${bandId}/albums/${id}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => (dirty ? setLeaveOpen(true) : leave())}
          className="btn-outline"
        >
          {dirty ? 'Cancel' : 'Back'}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className="btn-primary inline-flex items-center gap-2"
        >
          {busy && (
            <span aria-hidden="true" className="flex">
              <Spinner size="xs" tone="onFilled" />
            </span>
          )}
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      <h1 className="title-text">{albumId ? 'Edit album' : 'New album'}</h1>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Album name"
          className={inputCls}
        />
      </label>

      <SetlistItemsEditor
        items={items}
        onItemsChange={setItems}
        songPool={songPool}
        allowMarkers={false}
        allowDuplicates
        emptyText="No tracks yet. Use “Add songs” to build the running order."
        hint="Drag to reorder. Each track can play the song’s current version or one you pin."
        renderItemActions={(row) => {
          const t = asTrack(row);
          return (
            <button
              type="button"
              onClick={() => setPicking(t)}
              className={
                'shrink-0 rounded px-2 py-1 text-xs ' +
                (t.lost
                  ? 'text-warn hover:bg-amber-50 dark:hover:bg-neutral-800'
                  : 'minor-text-theme-colors hover:bg-surface-hover')
              }
            >
              {versionCaption(t)}
            </button>
          );
        }}
      />

      {picking && (
        <AlbumVersionPicker
          conversationId={picking.conversationId}
          songName={picking.name}
          selectedId={picking.audioVersionId}
          onSelect={(version) => setVersion(picking.id, version)}
          onClose={() => setPicking(null)}
        />
      )}

      <ConfirmModal
        open={leaveOpen}
        title="Discard changes?"
        description="This album has unsaved changes."
        confirmLabel="Discard"
        onConfirm={leave}
        onCancel={() => setLeaveOpen(false)}
      />
    </div>
  );
}

/** What the row's version button says, given the track's pin state. */
function versionCaption(t: AlbumEditorTrack): string {
  if (t.lost) return 'Version deleted';
  if (!t.audioVersionId) return 'Current version';
  return t.pinnedLabel ?? t.pinnedFileName ?? 'Pinned version';
}
