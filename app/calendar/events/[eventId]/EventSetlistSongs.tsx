'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useNavigate } from '../../../useNavigate';
import { ensureOk } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import {
  ActionMenu,
  ActionMenuItem,
  MenuIconRow,
  MenuSectionLabel,
} from '../../../ActionMenu';
import { useShareLink } from '../../../useShareLink';
import { EyeIcon, LinkIcon, PencilIcon } from '../../../icons';
import { songHref } from '@/lib/routes';
import { ConfirmModal } from '../../../ConfirmModal';
import { useTrackPending } from '../../../PendingActionProvider';
import { useToast } from '../../../ToastProvider';
import {
  usePlaylistPlayer,
  type PlaylistTrack,
} from '../../../player/PlaylistPlayer';
import { SongTitle } from '../../../SongTitle';

interface SongItem {
  id: string;
  conversationId: string | null;
  name: string;
  originalArtist: string | null;
  bpm: number | null;
  key: string | null;
  songLength: number | null;
  audioStoredName: string | null;
  audioMimeType: string | null;
  audioVersionId: string | null;
}

/**
 * The event's setlist songs, in order. Each song with audio gets a play button
 * that hands the whole setlist to the global player (queued from that song on),
 * so playback continues through the set and survives leaving the page. A kebab
 * offers view/edit/remove for band members (`canManage`); removal PATCHes the
 * setlist to its remaining items, then refreshes.
 */
export function EventSetlistSongs({
  bandId,
  setlistId,
  setlistName,
  canManage,
  songs,
}: {
  bandId: string;
  setlistId: string;
  setlistName: string;
  canManage: boolean;
  songs: SongItem[];
}) {
  const router = useRouter();
  const go = useNavigate();
  const share = useShareLink();
  const trackPending = useTrackPending();
  const showToast = useToast();
  const player = usePlaylistPlayer();
  const [removeTarget, setRemoveTarget] = useState<SongItem | null>(null);
  const [removing, setRemoving] = useState(false);

  // Length/duration reflect actual songs, not markers (set breaks etc.).
  const playableSongs = songs.filter((s) => s.conversationId);
  const totalSeconds = playableSongs.reduce(
    (sum, s) => sum + (s.songLength ?? 0),
    0,
  );
  const allLengthsKnown = playableSongs.every((s) => s.songLength != null);

  // The queue skips songs with no audio, so a song's queue position isn't its
  // position in the setlist.
  const withAudio = songs.filter(
    (s) => s.conversationId && s.audioStoredName && s.audioVersionId,
  );
  const queue: PlaylistTrack[] = withAudio.map((s) => ({
    id: s.conversationId!,
    title: s.name,
    src:
      `/api/conversations/${s.conversationId}/files/audio` +
      `?version=${s.audioVersionId}&name=${encodeURIComponent(s.audioStoredName!)}`,
    fileName: s.audioStoredName!,
    mimeType: s.audioMimeType ?? undefined,
    href: `/notes/${s.conversationId}/practice`,
    originalArtist: s.originalArtist ?? undefined,
    bpm: s.bpm,
    songKey: s.key,
    subtitle: setlistName,
    durationSec: s.songLength ?? undefined,
  }));

  const handleRemove = async () => {
    if (!removeTarget || removing) return;
    setRemoving(true);
    try {
      await trackPending(async () => {
        // Resend the setlist's items minus the removed song, in order.
        const items = songs
          .filter((s) => s.id !== removeTarget.id)
          .map((s) =>
            s.conversationId
              ? { conversationId: s.conversationId }
              : { label: s.name },
          );
        const r = await fetch(`/api/bands/${bandId}/setlists/${setlistId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        await ensureOk(r);
      });
      showToast('Song removed from setlist.', 'success');
      setRemoveTarget(null);
      router.refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  };

  if (songs.length === 0) {
    return (
      <p className="text-sm minor-text-theme-colors">
        This setlist has no songs.
      </p>
    );
  }

  return (
    <>
      {/* Play all / Shuffle all moved to the section's kebab (see
          EventSetlistActions), leaving this to state the set's length. */}
      <div className="flex flex-col items-start justify-between gap-2">
        <span className="shrink-0 text-sm minor-text-theme-colors">
          Total length: &nbsp; {allLengthsKnown ? '' : '~'}
          {formatDuration(totalSeconds)}
        </span>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {songs.map((s) => {
          if (!s.conversationId) {
            return (
              <li
                key={s.id}
                className="text-xs font-semibold uppercase tracking-wide minor-text-theme-colors pl-4"
              >
                {s.name}
              </li>
            );
          }
          const hasAudio = Boolean(s.audioStoredName);
          const isCurrent = player.track?.id === s.conversationId;
          const queueIndex = withAudio.findIndex((w) => w.id === s.id);
          return (
            <li key={s.id} className="flex items-center gap-2">
              {hasAudio ? (
                <button
                  type="button"
                  onClick={() =>
                    isCurrent ? player.toggle() : player.play(queue, queueIndex)
                  }
                  aria-label={
                    isCurrent && player.isPlaying
                      ? `Pause ${s.name}`
                      : `Play ${s.name}`
                  }
                  title={
                    isCurrent && player.isPlaying
                      ? `Pause ${s.name}`
                      : `Play ${s.name}`
                  }
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg-body hover:bg-surface-soft"
                >
                  {isCurrent && player.isPlaying ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
              ) : (
                // Keeps names aligned with the playable rows.
                <span
                  aria-hidden="true"
                  className="h-8 w-8 shrink-0 rounded-full border border-dashed border-line-strong"
                />
              )}

              <span
                className={
                  'min-w-0 flex-1 py-3 ml-2' +
                  (isCurrent ? 'font-medium text-accent-strong' : '')
                }
              >
                <SongTitle title={s.name} originalArtist={s.originalArtist} />
                {s.songLength != null && (
                  <span className="text-neutral-400">
                    {` - ${formatDuration(s.songLength)}`}
                  </span>
                )}
              </span>

              {canManage && (
                <ActionMenu label="Song actions">
                  <MenuSectionLabel>Song</MenuSectionLabel>
                  <MenuIconRow
                    items={[
                      {
                        key: 'view',
                        icon: <EyeIcon size={18} />,
                        label: `View ${s.name}`,
                        title: 'View song',
                        onClick: () => go(songHref(s.conversationId!)),
                      },
                      {
                        key: 'edit',
                        icon: <PencilIcon size={18} />,
                        label: `Edit ${s.name}`,
                        title: 'Edit song',
                        onClick: () => go(`/notes/${s.conversationId}/edit`),
                      },
                      {
                        key: 'share',
                        icon: <LinkIcon size={18} />,
                        label: `Copy a link to ${s.name}`,
                        title: 'Share song',
                        onClick: () =>
                          void share(songHref(s.conversationId!), 'Song'),
                      },
                    ]}
                  />
                  <ActionMenuItem
                    destructive
                    onClick={() => setRemoveTarget(s)}
                  >
                    Remove song from setlist
                  </ActionMenuItem>
                </ActionMenu>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmModal
        open={removeTarget !== null}
        title="Remove song?"
        description={`Remove “${removeTarget?.name ?? ''}” from this setlist? You can add it back later.`}
        confirmLabel="Remove song"
        busyLabel="Removing…"
        busy={removing}
        onConfirm={handleRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}
