'use client';

import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { Modal } from '../Modal';
import { LoadingBlock } from '../Spinner';
import { useToast } from '../ToastProvider';
import { useTrackPending } from '../PendingActionProvider';
import type { PlaylistTrack } from './PlaylistPlayer';
import { SongTitle } from '../SongTitle';

type BandSetlists = {
  bandId: string;
  setlists: { id: string; name: string }[];
};

/**
 * "Add to setlist" for a track in the player's queue. The queue only carries a
 * song id, so this looks up which band the song belongs to (and that band's
 * active setlists) on open, rather than expecting the caller to know — the
 * player follows you across bands.
 */
export function AddTrackToSetlistModal({
  track,
  onClose,
}: {
  track: PlaylistTrack;
  onClose: () => void;
}) {
  const showToast = useToast();
  const trackPending = useTrackPending();
  const [data, setData] = useState<BandSetlists | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    fetch(`/api/conversations/${track.id}/setlists`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorMessage(r));
        return (await r.json()) as BandSetlists;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [track.id]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = async () => {
    if (!data || busy || selected.size === 0) return;
    const ids = [...selected];
    setBusy(true);
    try {
      await trackPending(async () => {
        const results = await Promise.all(
          ids.map((sid) =>
            fetch(`/api/bands/${data.bandId}/setlists/${sid}/songs`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversationId: track.id }),
            }),
          ),
        );
        const bad = results.find((r) => !r.ok);
        if (bad) throw new Error(await errorMessage(bad));
      });
      showToast(
        `Added to ${ids.length} setlist${ids.length === 1 ? '' : 's'}.`,
        'success',
      );
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={busy}
      labelledBy="queue-add-setlist-title"
      size="sm"
    >
      <h2 id="queue-add-setlist-title" className="text-base font-semibold">
        Add to setlist
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        <SongTitle title={track.title} originalArtist={track.originalArtist} />
      </p>

      {loadError ? (
        <p className="mt-4 rounded-md border border-danger-line bg-danger-fill px-3 py-2 text-sm text-danger-strong">
          {loadError}
        </p>
      ) : !data ? (
        <LoadingBlock
          size="sm"
          className="mt-4 py-6"
          label="Loading setlists"
        />
      ) : data.setlists.length === 0 ? (
        <p className="mt-4 rounded-md border border-line px-3 py-6 text-center text-sm minor-text-theme-colors">
          No setlists yet. Create one first.
        </p>
      ) : (
        <ul className="mt-4 flex max-h-64 flex-col gap-1 overflow-auto">
          {data.setlists.map((sl) => (
            <li key={sl.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={selected.has(sl.id)}
                  onChange={() => toggle(sl.id)}
                  className="h-4 w-4"
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {sl.name}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="btn-ghost"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy || selected.size === 0}
          className="btn-primary"
        >
          {busy ? 'Adding…' : 'Add to setlist'}
        </button>
      </div>
    </Modal>
  );
}
