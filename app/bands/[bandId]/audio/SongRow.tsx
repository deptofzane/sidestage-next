'use client';

import Link from 'next/link';
import { useNavigate } from '../../../useNavigate';
import {
  ActionMenu,
  ActionMenuItem,
  MenuIconRow,
  MenuSectionLabel,
} from '../../../ActionMenu';
import { useShareLink } from '../../../useShareLink';
import { EyeIcon, LinkIcon, PencilIcon } from '../../../icons';
import { songHref } from '@/lib/routes';
import { formatSongMeta, formatTimeAgoOrDate } from '@/lib/format';
import { useToast } from '../../../ToastProvider';
import {
  usePlaylistPlayer,
  type PlaylistTrack,
} from '../../../player/PlaylistPlayer';
import { audioSrc, type Conversation } from '../bandDetailShared';

/**
 * A single audio-track row on the band's Audio page: a play button, a link to
 * the song, and a kebab menu of actions. Playback goes through the global
 * player — Play replaces the queue with this song, "Add song to queue" appends
 * it. Songs with no audio yet keep the play button's footprint so names stay
 * aligned. Presentational otherwise — the parent supplies the handlers.
 */
export function SongRow({
  c,
  bandName,
  disabled,
  onAddToSetlist,
  onAddToAlbum,
  onEdit,
  onView,
  onToggleArchive,
  onDelete,
}: {
  c: Conversation;
  /** Names the song in the player when it has no tempo or key of its own. */
  bandName: string | null;
  disabled: boolean;
  onAddToSetlist: (c: Conversation) => void;
  /** Omitted where there's no album modal to open — the action then hides. */
  onAddToAlbum?: (c: Conversation) => void;
  onEdit: (c: Conversation) => void;
  onView: (c: Conversation) => void;
  onToggleArchive: (c: Conversation) => void;
  onDelete: (c: Conversation) => void;
}) {
  const go = useNavigate();
  const share = useShareLink();
  const player = usePlaylistPlayer();
  const showToast = useToast();

  // Songs are named by their audio file here; the icon row's labels are
  // all a screen reader gets, so they need the same name the row shows.
  const songName = c.audioFileName ?? 'Untitled audio';
  const meta = formatSongMeta(c.bpm, c.key);
  const src = audioSrc(c);
  const isCurrent = player.track?.id === c.id;

  const track: PlaylistTrack | null = src
    ? {
        id: c.id,
        title: c.audioFileName ?? 'Untitled audio',
        src,
        fileName: c.audioStoredName ?? undefined,
        mimeType: c.audioMimeType ?? undefined,
        href: `/notes/${c.id}/practice?from=audio`,
        originalArtist: c.originalArtist ?? undefined,
        bpm: c.bpm,
        songKey: c.key,
        // Tempo and key first — that's what's useful while the song is
        // playing. The band only fills in for songs that have neither.
        subtitle: meta ?? bandName ?? undefined,
        durationSec: c.songLength ?? undefined,
      }
    : null;

  return (
    <li className="flex items-center gap-2 pr-4 hover:bg-surface-soft">
      {track ? (
        <button
          type="button"
          onClick={() =>
            isCurrent ? player.toggle() : player.play([track], 0)
          }
          aria-label={
            isCurrent && player.isPlaying
              ? `Pause ${track.title}`
              : `Play ${track.title}`
          }
          title={
            isCurrent && player.isPlaying
              ? `Pause ${track.title}`
              : `Play ${track.title}`
          }
          className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg-body bg-blue-50 hover:bg-blue-100 dark:bg-blue-700 dark:hover:bg-blue-500"
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
        <span
          aria-hidden="true"
          className="ml-3 h-8 w-8 shrink-0 rounded-full border border-dashed border-line-strong"
        />
      )}

      <Link
        href={`/notes/${c.id}/practice?from=audio`}
        className="min-w-0 flex-1 px-4 py-3 md:py-1.5 md:px-3 text-sm"
      >
        <div className="flex items-center gap-2">
          <span
            className={
              'truncate font-medium ' + (isCurrent ? 'text-accent-strong' : '')
            }
          >
            {c.audioFileName ?? 'Untitled audio'}
          </span>
          {c.closed && (
            <span className="shrink-0 rounded bg-fill-muted px-1.5 py-0.5 text-[0.625rem] font-medium minor-text-theme-colors dark:text-neutral-400">
              closed
            </span>
          )}
        </div>
        {c.originalArtist && (
          <div className="mt-0.5 truncate text-xs minor-text-theme-colors">
            Originally by {c.originalArtist}
          </div>
        )}
        {meta && (
          <div className="mt-0.5 text-xs minor-text-theme-colors">{meta}</div>
        )}
        <div className="mt-0.5 text-xs minor-text-theme-colors">
          Updated {formatTimeAgoOrDate(c.updatedAt)}
        </div>
      </Link>
      <ActionMenu label="Song actions" disabled={disabled}>
        <MenuSectionLabel>Song</MenuSectionLabel>
        <MenuIconRow
          items={[
            {
              key: 'view',
              icon: <EyeIcon size={18} />,
              label: `View ${songName}`,
              title: 'View song',
              onClick: () => onView(c),
            },
            {
              key: 'edit',
              icon: <PencilIcon size={18} />,
              label: `Edit ${songName}`,
              title: 'Edit song',
              onClick: () => onEdit(c),
            },
            {
              key: 'share',
              icon: <LinkIcon size={18} />,
              label: `Copy a link to ${songName}`,
              title: 'Share song',
              onClick: () => void share(songHref(c.id), 'Song'),
            },
          ]}
        />
        {track && (
          <ActionMenuItem
            onClick={() => {
              player.enqueue([track]);
              showToast('Added to queue.', 'success');
            }}
          >
            Add song to queue
          </ActionMenuItem>
        )}
        {c.hasSheetMusic && (
          <ActionMenuItem onClick={() => go(`/notes/${c.id}/live`)}>
            Live
          </ActionMenuItem>
        )}
        <ActionMenuItem onClick={() => onAddToSetlist(c)}>
          Add to setlist
        </ActionMenuItem>
        {/* Optional: surfaces only where the parent can host the modal. */}
        {onAddToAlbum && (
          <ActionMenuItem onClick={() => onAddToAlbum(c)}>
            Add to album
          </ActionMenuItem>
        )}
        <ActionMenuItem onClick={() => onToggleArchive(c)}>
          {c.archived ? 'Unarchive song' : 'Archive song'}
        </ActionMenuItem>
        <ActionMenuItem destructive onClick={() => onDelete(c)}>
          Delete
        </ActionMenuItem>
      </ActionMenu>
    </li>
  );
}
