'use client';

import { ensureOk } from '@/lib/api';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTrackPending } from '../../../../PendingActionProvider';
import { useToast } from '../../../../ToastProvider';
import { SetlistItemsEditor, type SetlistItem } from '../SetlistItemsEditor';

interface SongOption {
  id: string;
  name: string;
  originalArtist: string | null;
}

/**
 * Build a setlist: name it, then add songs, set breaks, or custom markers,
 * reordering (drag-and-drop) as needed. "Done" creates the setlist and
 * returns to the band page. The item list / add flow lives in the shared
 * SetlistItemsEditor.
 */
export function NewSetlistClient({
  bandId,
  songs,
}: {
  bandId: string;
  songs: SongOption[];
}) {
  const router = useRouter();
  const trackPending = useTrackPending();
  const showToast = useToast();

  const [name, setName] = useState('');
  const [items, setItems] = useState<SetlistItem[]>([]);
  const [busy, setBusy] = useState(false);

  const songPool = songs.map((s) => ({
    conversationId: s.id,
    name: s.name,
    originalArtist: s.originalArtist,
  }));

  const handleDone = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await trackPending(async () => {
        const r = await fetch(`/api/bands/${bandId}/setlists`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: trimmed,
            items: items.map((s) => ({
              conversationId: s.conversationId,
              label: s.conversationId ? null : s.name,
            })),
          }),
        });
        await ensureOk(r);
      });
      showToast('Setlist created.', 'success');
      // `replace`, not `push`: a form left in history is what Back returns to.
      router.replace(`/bands/${bandId}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="title-text">New setlist</h1>
        <button
          type="button"
          onClick={handleDone}
          disabled={busy || !name.trim()}
          className="shrink-0 btn-primary"
        >
          {busy ? 'Saving…' : 'Done'}
        </button>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={255}
        placeholder="Setlist name"
        className="rounded-md border border-line-strong bg-surface px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />

      <SetlistItemsEditor
        items={items}
        onItemsChange={setItems}
        songPool={songPool}
        emptyText={
          songs.length === 0
            ? 'This band has no songs yet — you can still add set breaks or custom items.'
            : 'Nothing added yet. Add songs, a set break, or something custom.'
        }
      />
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={handleDone}
          disabled={busy || !name.trim()}
          className="shrink-0 btn-primary"
        >
          {busy ? 'Saving…' : 'Done'}
        </button>
      </div>
    </div>
  );
}
