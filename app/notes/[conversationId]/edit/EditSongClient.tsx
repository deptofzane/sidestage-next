'use client';

import { ensureOk } from '@/lib/api';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCanGoBack } from '../../../NavigationHistoryProvider';
import { ConfirmModal } from '../../../ConfirmModal';
import { useTrackPending } from '../../../PendingActionProvider';
import { useToast } from '../../../ToastProvider';
import { Spinner } from '../../../Spinner';
import { AudioVersions, type AudioVersionMeta } from './AudioVersions';
import {
  SheetMusicVersions,
  type SheetVersionMeta,
} from './SheetMusicVersions';

interface BandOption {
  id: string;
  name: string;
}

/**
 * Edit a song: rename it, move it to another band you belong to, and set its
 * tempo/key — all committed together via "Save all changes" (Cancel discards
 * and returns to the song). Sheet music and audio versions manage themselves;
 * archive and delete stay separate actions. Any band member can edit; the API
 * enforces membership.
 */
const inputCls =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export function EditSongClient({
  conversationId,
  apiKey,
  initialName,
  initialBandId,
  initialArchived,
  initialOriginalArtist,
  initialBpm,
  initialKey,
  bands,
  audioVersions,
  sheetVersions,
}: {
  conversationId: string;
  apiKey: string;
  initialName: string;
  initialBandId: string;
  initialArchived: boolean;
  initialOriginalArtist: string | null;
  initialBpm: number | null;
  initialKey: string | null;
  bands: BandOption[];
  audioVersions: AudioVersionMeta[];
  sheetVersions: SheetVersionMeta[];
}) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const trackPending = useTrackPending();
  const showToast = useToast();

  const [name, setName] = useState(initialName);
  const [bandId, setBandId] = useState(initialBandId);
  const [archived, setArchived] = useState(initialArchived);
  const [originalArtist, setOriginalArtist] = useState(
    initialOriginalArtist ?? '',
  );
  const [bpm, setBpm] = useState(initialBpm != null ? String(initialBpm) : '');
  const [key, setKey] = useState(initialKey ?? '');
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);

  // Baselines to diff against. A successful save navigates away, so these
  // never need to change after mount.
  const savedName = initialName;
  const savedBandId = initialBandId;
  const savedOriginalArtist = initialOriginalArtist ?? '';
  const savedBpm = initialBpm != null ? String(initialBpm) : '';
  const savedKey = initialKey ?? '';

  const songHref = `/notes/${conversationId}`;
  const nameTrim = name.trim();
  const originalArtistTrim = originalArtist.trim();
  const bpmTrim = bpm.trim();
  const keyTrim = key.trim();
  const dirty =
    nameTrim !== savedName ||
    bandId !== savedBandId ||
    originalArtistTrim !== savedOriginalArtist ||
    bpmTrim !== savedBpm ||
    keyTrim !== savedKey;
  const canSave = dirty && nameTrim !== '' && !busy;

  // Guard a hard unload (refresh / tab close) while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Return to the page the user came from (in-app history), falling back to
  // the song itself on a fresh load / deep link.
  //
  // No `router.refresh()` here. It refetches the route you're on — this one,
  // about to be discarded — while `router.back()` restores the destination
  // from the client Router Cache as it was left, still showing pre-edit data.
  // `RefreshAfterEdit` in the root layout refreshes the page we land on
  // instead, which is the only place that can outlive this navigation.
  //
  // That it fires on Cancel too matters here: the version panels below (audio
  // and sheet music) write immediately — renaming a version, changing the
  // default, deleting one — so leaving without saving still leaves changes
  // the song page has to reflect.
  const leave = () => {
    if (canGoBack()) router.back();
    else router.replace(songHref);
  };

  // Cancel: confirm first if there are unsaved edits, otherwise leave directly.
  const handleCancel = () => {
    if (dirty) setLeaveOpen(true);
    else leave();
  };

  const patch = async (payload: Record<string, unknown>) => {
    const res = await fetch(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await ensureOk(res);
  };

  const handleSaveAll = async () => {
    if (!canSave) return;
    const nextBpm = bpmTrim === '' ? null : Number(bpmTrim);
    if (
      nextBpm !== null &&
      (!Number.isInteger(nextBpm) || nextBpm < 1 || nextBpm > 400)
    ) {
      showToast('BPM must be a whole number from 1 to 400.');
      return;
    }
    const nextKey = keyTrim === '' ? null : keyTrim;

    // Send only what changed, so the API doesn't emit a spurious update.
    const payload: Record<string, unknown> = {};
    if (nameTrim !== savedName) payload.name = nameTrim;
    if (bandId !== savedBandId) payload.bandId = bandId;
    if (originalArtistTrim !== savedOriginalArtist)
      payload.originalArtist =
        originalArtistTrim === '' ? null : originalArtistTrim;
    if (bpmTrim !== savedBpm) payload.bpm = nextBpm;
    if (keyTrim !== savedKey) payload.key = nextKey;

    setBusy(true);
    try {
      await trackPending(() => patch(payload));
      showToast('Song saved.', 'success');
      // Return to wherever the user opened Edit from (setlist, event, the song
      // page…), falling back to the song on a deep link.
      leave();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleToggleArchive = async () => {
    if (busy) return;
    const next = !archived;
    setBusy(true);
    try {
      await trackPending(() => patch({ archived: next }));
      setArchived(next);
      showToast(next ? 'Song archived.' : 'Song unarchived.', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await trackPending(async () => {
        const res = await fetch(`/api/conversations/${conversationId}`, {
          method: 'DELETE',
        });
        await ensureOk(res, [204]);
      });
      // Same cache problem as `leave()`: without this the list still holds a
      // payload containing the song that was just deleted.
      router.refresh();
      // `replace`: Back must not return to an editor for something now deleted.
      router.replace('/open-conversations');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={handleCancel} className="btn-outline">
          {dirty ? 'Cancel' : 'Back'}
        </button>
      </div>

      <h1 className="title-text">Edit song</h1>

      {/* Name */}
      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={255}
          className={inputCls}
        />
      </section>

      {/* Band */}
      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium">Band</label>
        <select
          value={bandId}
          onChange={(e) => setBandId(e.target.value)}
          className={inputCls}
        >
          {bands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <p className="text-[0.6875rem] minor-text-theme-colors">
          Moving changes who can access this song — only members of the new band
          will see it.
        </p>
      </section>

      {/* Details (original artist / tempo / key) */}
      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium">Details</label>
        <div className="flex flex-col gap-1">
          <span className="text-xs minor-text-theme-colors">
            Original artist
          </span>
          <input
            value={originalArtist}
            onChange={(e) => setOriginalArtist(e.target.value)}
            maxLength={120}
            placeholder="e.g. Fleetwood Mac"
            className={inputCls}
          />
        </div>
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-xs minor-text-theme-colors">BPM</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={400}
              value={bpm}
              onChange={(e) => setBpm(e.target.value)}
              placeholder="—"
              className={inputCls}
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-xs minor-text-theme-colors">Key</span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={24}
              placeholder="e.g. Am"
              className={inputCls}
            />
          </div>
        </div>
        <p className="text-[0.6875rem] minor-text-theme-colors">
          All optional — who the song is originally by (for covers), its tempo,
          and its musical key. Leave blank if unknown.
        </p>
      </section>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleSaveAll}
          disabled={!canSave}
          className="btn-primary inline-flex items-center gap-2 w-full justify-center"
        >
          {/* Decorative: the label already reads "Saving…". */}
          {busy && (
            <span aria-hidden="true" className="flex">
              <Spinner size="xs" tone="onFilled" />
            </span>
          )}
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      <p className="text-[0.6875rem] minor-text-theme-colors">
        Audio and sheet music will save automatically as soon as it’s uploaded.
      </p>

      {/* Audio versions */}
      {/* `savedBandId`, not the picker's `bandId`: uploads save immediately,
          so they land in the band the song is in now, not one chosen but not
          yet saved. */}
      <AudioVersions
        bandId={savedBandId}
        conversationId={conversationId}
        apiKey={apiKey}
        initial={audioVersions}
      />

      {/* Sheet music versions */}
      <SheetMusicVersions
        bandId={savedBandId}
        conversationId={conversationId}
        apiKey={apiKey}
        initial={sheetVersions}
      />

      {/* Archive */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Archive</h2>
        <p className="text-[0.6875rem] minor-text-theme-colors">
          {archived
            ? 'This song is archived — it appears under “Archived Audio” on the band page.'
            : 'Archiving moves this song into a separate “Archived Audio” list on the band page. It keeps all of its notes and files.'}
        </p>
        <div>
          <button
            type="button"
            onClick={handleToggleArchive}
            disabled={busy}
            className="btn-outline"
          >
            {archived ? 'Unarchive song' : 'Archive song'}
          </button>
        </div>
      </section>

      {/* Danger zone */}
      <section className="flex flex-col gap-2 rounded-lg border border-red-200 p-4 dark:border-red-900">
        <h2 className="text-sm font-medium text-danger">Delete song</h2>
        <p className="text-xs text-fg-muted">
          Permanently deletes this song and all of its notes, sheet music, and
          activity. This can’t be undone.
        </p>
        <div>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="rounded-md border border-danger-line px-4 py-3 md:py-1.5 md:px-3 text-sm font-medium text-danger hover:bg-danger-fill"
          >
            Delete song
          </button>
        </div>
      </section>

      <ConfirmModal
        open={deleteOpen}
        title="Delete song?"
        description="This permanently deletes the song and all of its notes, sheet music, and activity. This can’t be undone."
        confirmLabel="Delete song"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />

      <ConfirmModal
        open={leaveOpen}
        title="Leave without saving?"
        description="Changes have been made. Are you sure you want to leave without saving?"
        confirmLabel="Leave without saving"
        onConfirm={leave}
        onCancel={() => setLeaveOpen(false)}
      />
    </div>
  );
}
