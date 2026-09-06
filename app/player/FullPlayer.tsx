'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useNavigate } from '../useNavigate';
import { formatDuration } from '@/lib/format';
import {
  ActionMenu,
  ActionMenuItem,
  MenuIconRow,
  MenuSectionLabel,
} from '../ActionMenu';
import { useShareLink } from '../useShareLink';
import { EyeIcon, LinkIcon, PencilIcon } from '../icons';
import { songHref } from '@/lib/routes';
import { ShuffleIcon } from './icons';
import { AddTrackToSetlistModal } from './AddTrackToSetlistModal';
import { usePlaylistPlayer, type PlaylistTrack } from './PlaylistPlayer';
import {
  PlayerProvider,
  type PlayerControls,
} from '../notes/[conversationId]/PlayerContext';
import { NotesPanel } from '../notes/[conversationId]/NotesPanel';
import type { RepeatMode } from './queueOrder';
import { SongTitle } from '../SongTitle';

/** Hover text per repeat mode — what the button is currently doing. */
const REPEAT_TITLE: Record<RepeatMode, string> = {
  off: 'Repeat off',
  all: 'Repeat all',
  one: 'Repeat this song',
};

/**
 * The maximized player: the bottom bar's contents blown up to full screen with
 * the whole queue listed underneath, any entry clickable to jump to it, and a
 * Practice link that takes the queue over to the Practice page (sheet music,
 * speed, 10s skips) — same queue, same engine, so the hand-off doesn't
 * interrupt playback.
 *
 * Mounted by `MiniPlayer` while expanded — Escape or the collapse button
 * returns to the bar, and playback is untouched either way.
 */
export function FullPlayer({
  onCollapse,
  currentUserId,
}: {
  onCollapse: () => void;
  /** Null when signed out — the comments panel needs an author. */
  currentUserId: string | null;
}) {
  const {
    track,
    queue,
    index,
    isPlaying,
    currentTime,
    duration,
    error,
    toggle,
    next,
    previous,
    hasNext,
    shuffle,
    toggleShuffle,
    repeat,
    cycleRepeat,
    seek,
    play,
    remove,
  } = usePlaylistPlayer();

  const currentRef = useRef<HTMLLIElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Queue entry whose "Add to setlist" modal is open.
  const [addTarget, setAddTarget] = useState<PlaylistTrack | null>(null);
  const [showComments, setShowComments] = useState(false);
  const go = useNavigate();
  const share = useShareLink();

  // The notes UI seeks the player and stamps notes with the playing position.
  // On the song page those come from that page's own engine; here they have to
  // come from the queue's, so the transport is handed over directly. Read
  // through a ref so the memo doesn't capture a stale time.
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;
  const noteControls = useMemo<PlayerControls>(
    () => ({
      seek,
      getCurrentTime: () => timeRef.current,
      // The queue owns its engine; there's nothing for notes to register.
      setEngine: () => {},
    }),
    [seek],
  );

  // Leaving for a page: collapse first, or the overlay stays up covering the
  // page that was just navigated to. Same reason the links in here do it.
  const goTo = (href: string) => {
    onCollapse();
    go(href);
  };

  // Escape collapses, and the page behind shouldn't scroll under the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog opened inside the overlay owns Escape — don't collapse out
      // from under it.
      if (rootRef.current?.querySelector('[role="dialog"]')) return;
      onCollapse();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onCollapse]);

  // Keep the playing track visible as the queue advances.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!track) return null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Audio player"
      className="fixed inset-0 z-50 flex flex-col bg-surface"
    >
      {/* Collapse is the only way out of here — dismissing the queue lives on
          the bar this collapses back to. */}
      <header className="flex shrink-0 items-center justify-end gap-2 border-b border-line px-3 py-2 lg:px-6">
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse player"
          title="Collapse player"
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg-dim hover:bg-surface-hover"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-2xl shrink-0 flex-col gap-3 px-4 py-6">
          <div className="flex flex-col gap-1 text-center">
            {track.href ? (
              <Link
                href={track.href}
                onClick={onCollapse}
                className="truncate text-lg font-semibold hover:underline"
              >
                {track.title}
              </Link>
            ) : (
              <h2 className="truncate text-lg font-semibold">{track.title}</h2>
            )}
            {/* Above the subtitle, where tempo and key land — same order the
                mini player uses. */}
            {track.originalArtist && (
              <p className="truncate text-sm minor-text-theme-colors">
                Originally by {track.originalArtist}
              </p>
            )}
            {track.subtitle && (
              <p className="truncate text-sm minor-text-theme-colors">
                {track.subtitle}
              </p>
            )}
            {queue.length > 1 && (
              <p className="text-xs tabular-nums minor-text-theme-colors">
                {index + 1} of {queue.length}
              </p>
            )}
          </div>

          {error ? (
            <p className="rounded-md border border-danger-line bg-danger-fill px-3 py-2 text-center text-sm text-danger-strong">
              {error}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-xs tabular-nums minor-text-theme-colors">
                {formatDuration(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={currentTime}
                onChange={(e) => seek(parseFloat(e.target.value))}
                disabled={duration <= 0}
                aria-label="Seek"
                className="min-w-0 flex-1 accent-blue-600"
              />
              <span className="shrink-0 font-mono text-xs tabular-nums minor-text-theme-colors">
                {formatDuration(duration)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-center gap-6">
            {/* A mode, not a transport action, so it's a toggle: `aria-pressed`
                carries the state, and the blue matches the play button rather
                than inventing a second "on" colour. Pointless below two
                tracks. */}
            <button
              type="button"
              onClick={toggleShuffle}
              disabled={queue.length < 2}
              aria-pressed={shuffle}
              aria-label="Shuffle"
              title={shuffle ? 'Shuffle on' : 'Shuffle off'}
              className={
                'flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-40 ' +
                (shuffle
                  ? 'text-accent hover:bg-blue-50 dark:hover:bg-neutral-800'
                  : 'text-fg-body hover:bg-surface-hover')
              }
            >
              <ShuffleIcon size={20} />
            </button>
            <button
              type="button"
              onClick={previous}
              aria-label="Previous song"
              title="Previous song"
              className="flex h-11 w-11 items-center justify-center rounded-full text-fg-body hover:bg-surface-hover"
            >
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M7 6h2v12H7zM19 6v12l-9-6z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              title={isPlaying ? 'Pause' : 'Play'}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-500"
            >
              {isPlaying ? (
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={next}
              disabled={!hasNext}
              aria-label="Next song"
              title="Next song"
              className="flex h-11 w-11 items-center justify-center rounded-full text-fg-body hover:bg-surface-hover disabled:opacity-40"
            >
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M15 6h2v12h-2zM5 6l9 6-9 6z" />
              </svg>
            </button>
            {/* Three states rather than a toggle, so `aria-pressed` would be a
                lie — the label carries the current mode instead, and clicking
                cycles off → all → one. */}
            <button
              type="button"
              onClick={cycleRepeat}
              aria-label={`Repeat: ${repeat}`}
              title={REPEAT_TITLE[repeat]}
              className={
                'flex h-11 w-11 items-center justify-center rounded-full ' +
                (repeat === 'off'
                  ? 'text-fg-body hover:bg-surface-hover'
                  : 'text-accent hover:bg-blue-50 dark:hover:bg-neutral-800')
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m17 2 4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="m7 22-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
                {/* The "1" that distinguishes repeat-one from repeat-all. */}
                {repeat === 'one' && <path d="M11 10h1v4" />}
              </svg>
            </button>
          </div>

          {/* Opens the song that's playing on the standard Practice page —
              sheet music, speed, 10s skips. Practice runs its own engine, so
              this hands over the song rather than the queue. */}
          <div className="flex justify-center gap-2">
            <Link
              href={`/notes/${track.id}/practice`}
              onClick={onCollapse}
              className="btn-outline"
            >
              Go to Practice
            </Link>
            {currentUserId && (
              <button
                type="button"
                onClick={() => setShowComments((v) => !v)}
                aria-expanded={showComments}
                className="btn-outline"
              >
                {showComments ? 'Show queue' : 'Show comments'}
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          <div className="mx-auto w-full max-w-2xl px-4 py-3">
            {showComments && currentUserId ? (
              /* Keyed by song: stepping the queue with comments open should
                 load that song's thread, not keep the last one's. */
              <PlayerProvider controls={noteControls}>
                <NotesPanel
                  key={track.id}
                  conversationId={track.id}
                  currentUserId={currentUserId}
                  canCloseConversation={false}
                />
              </PlayerProvider>
            ) : (
              <>
                <h3 className="pb-2 text-xs font-medium uppercase tracking-wide minor-text-theme-colors">
                  Queue
                </h3>
                <ul className="divide-y divide-line">
                  {queue.map((t, i) => {
                    const isCurrent = i === index;
                    return (
                      <li
                        key={`${t.id}-${i}`}
                        ref={isCurrent ? currentRef : null}
                        className="flex items-center gap-1"
                      >
                        <button
                          type="button"
                          onClick={() => play(queue, i)}
                          aria-current={isCurrent ? 'true' : undefined}
                          className={
                            'flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left text-sm hover:bg-surface-soft ' +
                            (isCurrent ? 'text-accent-strong' : '')
                          }
                        >
                          <span className="w-5 shrink-0 text-right text-xs tabular-nums text-neutral-400">
                            {isCurrent && isPlaying ? (
                              <span aria-label="Playing" title="Playing">
                                ♪
                              </span>
                            ) : (
                              i + 1
                            )}
                          </span>
                          <span
                            className={
                              'min-w-0 flex-1 ' +
                              (isCurrent ? 'font-medium' : '')
                            }
                          >
                            <SongTitle
                              title={t.title}
                              originalArtist={t.originalArtist}
                            />
                          </span>
                          {t.durationSec != null && (
                            <span className="shrink-0 text-xs tabular-nums minor-text-theme-colors">
                              {formatDuration(t.durationSec)}
                            </span>
                          )}
                        </button>

                        <ActionMenu label={`Actions for ${t.title}`}>
                          {/* View uses the track's own href where it has one:
                              that carries the `?from=` which sends Back to the
                              right place. Share deliberately doesn't — a
                              back-link is meaningless to whoever you send it
                              to, so it copies the plain song URL. */}
                          <MenuSectionLabel>Song</MenuSectionLabel>
                          <MenuIconRow
                            items={[
                              {
                                key: 'view',
                                icon: <EyeIcon size={18} />,
                                label: `View ${t.title}`,
                                title: 'View song',
                                onClick: () => goTo(t.href ?? songHref(t.id)),
                              },
                              {
                                key: 'edit',
                                icon: <PencilIcon size={18} />,
                                label: `Edit ${t.title}`,
                                title: 'Edit song',
                                onClick: () => goTo(`/notes/${t.id}/edit`),
                              },
                              {
                                key: 'share',
                                icon: <LinkIcon size={18} />,
                                label: `Copy a link to ${t.title}`,
                                title: 'Share song',
                                onClick: () =>
                                  void share(songHref(t.id), 'Song'),
                              },
                            ]}
                          />
                          <ActionMenuItem onClick={() => remove(i)}>
                            Remove from queue
                          </ActionMenuItem>
                          <ActionMenuItem onClick={() => setAddTarget(t)}>
                            Add to setlist
                          </ActionMenuItem>
                        </ActionMenu>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      {addTarget && (
        <AddTrackToSetlistModal
          track={addTarget}
          onClose={() => setAddTarget(null)}
        />
      )}
    </div>
  );
}
