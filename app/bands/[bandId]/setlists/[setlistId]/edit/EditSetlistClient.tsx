'use client';

import { ensureOk } from '@/lib/api';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTrackPending } from '../../../../../PendingActionProvider';
import { useToast } from '../../../../../ToastProvider';
import { SetlistItemsEditor, type SetlistItem } from '../../SetlistItemsEditor';
import { useCanGoBack } from '@/app/NavigationHistoryProvider';

interface BandSong {
  conversationId: string;
  name: string;
  originalArtist: string | null;
}

/**
 * Edit a setlist's items: add songs, set breaks, or custom markers; remove
 * and reorder (drag-and-drop). All edits are local until Save, which PATCHes
 * the full item list; Cancel discards them. The item list / add flow lives in
 * the shared SetlistItemsEditor.
 */
export function EditSetlistClient({
  bandId,
  setlistId,
  name,
  initialSongs,
  bandSongs,
}: {
  bandId: string;
  setlistId: string;
  name: string;
  initialSongs: SetlistItem[];
  /** All the band's unarchived songs — the pool to add from. */
  bandSongs: BandSong[];
}) {
  const router = useRouter();
  const trackPending = useTrackPending();
  const showToast = useToast();
  const canGoBack = useCanGoBack();

  const [items, setItems] = useState<SetlistItem[]>(initialSongs);
  const [title, setTitle] = useState(name);
  const [saving, setSaving] = useState(false);

  const viewHref = `/bands/${bandId}/setlists/${setlistId}`;
  // Compare by content (song id or marker label), so add/remove/reorder/rename
  // all count — but the row id (which changes on save) doesn't.
  const serialize = (list: SetlistItem[]) =>
    list.map((s) => s.conversationId ?? `marker:${s.name}`).join('|');
  const trimmed = title.trim();
  const renamed = trimmed !== name;
  const dirty = renamed || serialize(initialSongs) !== serialize(items);
  // An empty name isn't a rename, it's an unfinished one — the same 1–255
  // rule the API and the create form apply.
  const nameValid = trimmed.length > 0 && trimmed.length <= 255;

  // Return to the page the user came from (in-app history), falling back to
  // the song itself on a fresh load / deep link.
  // No `router.refresh()` here: it would refetch *this* route, the one being
  // left. Refreshing the page we land on is `RefreshAfterEdit`'s job, in the
  // root layout, where it outlives this component.
  const leave = () => {
    if (canGoBack()) router.back();
    else router.replace(viewHref);
  };

  const handleSave = async () => {
    if (!dirty || saving || !nameValid) return;
    setSaving(true);
    try {
      await trackPending(async () => {
        const r = await fetch(`/api/bands/${bandId}/setlists/${setlistId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Only when it actually changed, so an ordinary reorder doesn't
            // rewrite the name and bump `updatedAt` for nothing.
            ...(renamed ? { name: trimmed } : {}),
            items: items.map((s) => ({
              conversationId: s.conversationId,
              label: s.conversationId ? null : s.name,
            })),
          }),
        });
        await ensureOk(r);
      });
      showToast('Setlist saved.', 'success');
      router.refresh();
      // `replace`, not `push`: a form left in history is what Back returns to.
      router.replace(viewHref);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 mt-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={leave} className="btn-outline">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving || !nameValid}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="flex flex-col gap-1">
        <label htmlFor="setlist-name" className="text-sm font-medium">
          Name
        </label>
        <input
          id="setlist-name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={255}
          aria-invalid={!nameValid}
          className="rounded-md border border-line-strong bg-surface px-3 py-2 text-lg font-semibold focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        {!nameValid && (
          <p className="text-xs text-danger">A setlist needs a name.</p>
        )}
      </div>

      <SetlistItemsEditor
        items={items}
        onItemsChange={setItems}
        songPool={bandSongs}
        emptyText="Nothing in this setlist yet. Add songs, a set break, or something custom."
        hint="Drag the handle to reorder (or focus it and use the arrow keys); remove an item with ✕."
      />

      <footer className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={leave} className="btn-outline">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving || !nameValid}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </div>
  );
}
