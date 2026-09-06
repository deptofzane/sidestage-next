'use client';

import { PlayerProvider } from './notes/[conversationId]/PlayerContext';
import { NotesPanel } from './notes/[conversationId]/NotesPanel';
import { usePlaylistPlayer } from './player/PlaylistPlayer';
import { useShareLink } from './useShareLink';
import { LinkIcon, PencilIcon } from './icons';
import { songHref } from '@/lib/routes';
import {
  AudioPlayer,
  type PlayerVersion,
} from './notes/[conversationId]/AudioPlayer';
import { PageHeader } from './PageHeader';
import { SetlistNav } from './SetlistNav';
import { usePersistedIndex } from './usePersistedIndex';
import { useIsDesktop } from './useIsDesktop';
import {
  SheetMusic,
  type SheetMusicMeta,
} from './notes/[conversationId]/SheetMusic';
import Link from 'next/link';
import { SongTitle } from './SongTitle';
import {
  useEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

export interface PracticeSong {
  /** Null for a marker step (set break / custom) — shown without a player. */
  conversationId: string | null;
  /** Display title, also the audio filename (its extension hints the format). */
  title: string;
  /** Audio MIME type; defaults to audio/mpeg when unknown. */
  mimeType?: string;
  /** Who the song is originally by, for covers. */
  originalArtist?: string | null;
  /** Tempo / musical key, shown by the player when known. */
  bpm?: number | null;
  songKey?: string | null;
  /** Sheet music to show beneath the player, if the song has any. */
  sheetMusic?: SheetMusicMeta | null;
  /** Every audio version; two or more puts a switcher in the player. */
  audioVersions?: PlayerVersion[];
  /**
   * Audio URL to stream. Defaults to the song's default audio version —
   * callers that already know the exact URL (the player's queue) pass theirs
   * so practice plays the same file the queue does.
   */
  src?: string;
}

/**
 * Step through a setlist one song at a time for practice: a nav bar with
 * back/forward plus "{title} - {n}/{total}", the music player, and the song's
 * sheet music (if any). Narrow screens stack those top to bottom; from `lg` up
 * the nav spans the full width with the player in a narrow rail beneath it,
 * and the sheet music takes the rest. Either way the player alone stays pinned
 * to the top of the viewport while the sheet music scrolls under it — the nav
 * scrolls away with the page. Desktop swaps the player for a vertical variant
 * sized for the rail (see AudioPlayer's `variant`).
 *
 * Each song gets a fresh player (the provider is keyed by conversation id), so
 * switching tears down the old audio engine and spins up a clean one.
 */
export function Practice({
  songs,
  bandId,
  apiKey,
  persistKey,
  index: controlledIndex,
  onIndexChange,
  onNavigate,
  back,
  startIndex,
  shareHref,
  canCloseConversation = false,
  initialThreadId,
}: {
  songs: PracticeSong[];
  /** The band these songs belong to, for the storage warning. */
  bandId?: string;
  apiKey: string;
  /** localStorage key to remember the last-viewed song (per set). */
  persistKey?: string;
  /**
   * Controlled position. When passed (with `onIndexChange`), the owner keeps
   * the current song — used by the full-screen player, whose Practice tab
   * opens on whatever the queue is playing.
   */
  index?: number;
  onIndexChange?: Dispatch<SetStateAction<number>>;
  /** Called when a link inside leaves the page (lets an overlay close). */
  onNavigate?: () => void;
  /**
   * Where the page's back link goes. Given one, Practice renders the page
   * header itself so "Edit song" can sit in it — the link points at whichever
   * song you've stepped to, which only this component knows.
   */
  back?: { href: string; name?: string };
  /**
   * Open on this position instead of wherever you last left off — a shared
   * link naming a song. Only read on mount.
   */
  startIndex?: number | null;
  /**
   * A note thread to open on arrival, from a `?thread=` link. Belongs to the
   * song this screen opened on, so it's only meaningful for the single-song
   * route — a setlist link names a song by position, not a thread.
   */
  initialThreadId?: string | null;
  /**
   * Whether the comments panel offers Close / Reopen. On for a single song,
   * whose practice screen is that song's home; off while stepping a setlist,
   * where closing a conversation isn't what you're there for.
   */
  canCloseConversation?: boolean;
  /**
   * The URL for a given position. Supplying it makes the current song part of
   * the address (so the link in the bar is always the song on screen) and adds
   * a "Copy link" action — a PWA has no address bar to copy from.
   */
  shareHref?: (index: number) => string;
}) {
  const [ownIndex, setOwnIndex] = usePersistedIndex(
    persistKey ?? null,
    songs.length,
    startIndex,
  );
  // The desktop player is a different component, not a restyled one, so the
  // choice can't live in a `lg:` class. Resolves after mount (see the hook),
  // which means a beat of the bar layout before the rail takes over.
  const isDesktop = useIsDesktop();
  // Who's looking, for the comments panel at the bottom. From the player's
  // context rather than a prop: `/practice` is a precached static shell and
  // can't resolve a user server-side. Null when signed out — the panel then
  // has no one to attribute a comment to, so it isn't rendered.
  const { currentUserId } = usePlaylistPlayer();
  const share = useShareLink();
  const controlled = controlledIndex != null && onIndexChange != null;
  const index = controlled ? controlledIndex : ownIndex;
  const setIndex = controlled ? onIndexChange : setOwnIndex;

  // Keep the address in step with the song on screen, so whatever gets copied
  // — from the bar, or by the button below — points where the user is looking.
  // `replaceState`: no navigation, and no history entry per song.
  const position = Math.min(index, Math.max(0, songs.length - 1));
  const shareUrl = shareHref?.(position);
  useEffect(() => {
    if (!shareUrl || typeof window === 'undefined') return;
    window.history.replaceState(window.history.state, '', shareUrl);
  }, [shareUrl]);

  // The page header, when we own it. `song` isn't resolved yet at the empty
  // check below, so the Edit link is passed in by each caller of this.
  const header = (action?: ReactNode) =>
    back && (
      <div className="px-4 py-0">
        <PageHeader defaultHref={back.href} defaultHrefName={back.name}>
          {action}
        </PageHeader>
      </div>
    );

  if (songs.length === 0) {
    return (
      <>
        {header()}
        <p className="rounded-md border border-line px-3 py-6 text-center text-sm minor-text-theme-colors">
          This setlist has no songs to practice.
        </p>
      </>
    );
  }

  const total = songs.length;
  // Clamp in case the list shrank since the last render.
  const current = Math.min(index, total - 1);
  const song = songs[current]!;
  const canBack = current > 0;
  const canForward = current < total - 1;
  // Both loaders fill `audioVersions`; the queue passes an explicit `src`.
  const hasAudio = Boolean(song.src) || (song.audioVersions?.length ?? 0) > 0;

  const navBtn =
    'shrink-0 rounded-md border border-line-strong px-3 py-2 text-lg leading-none font-medium hover:bg-surface-soft disabled:opacity-40';

  // Desktop (`lg`+): a narrow player rail on the left, sheet music filling the
  // rest. Below `lg` they stack. The song nav sits above both, full width —
  // the rail is too narrow to hold a title and two buttons.
  //
  // `items-start` is what it looks like: the rail sticks on its own now, and
  // its parent is this row, which already runs as tall as the sheet music.
  const rowCls = 'flex flex-col gap-2 lg:flex-row lg:items-start lg:gap-4';
  const mainCls = 'min-w-0 lg:flex-1';

  // The player, plus the rail around it on desktop.
  //
  // `contents` takes this wrapper out of the box tree below `lg`, promoting
  // the player to a direct child of `rowCls` — the tall column that also holds
  // the sheet music, which is the box the player's own `sticky top-0` travels
  // inside (it brings an opaque background too; see AudioPlayerView's `sticky`
  // prop). `top-0` is clear there because the app's nav bar is pinned to the
  // bottom on mobile. At `lg` this re-forms as the rail and does the sticking
  // itself, at an offset that clears the desktop nav bar — `fixed` at the top
  // and 4.5rem tall. z-50 keeps it above the sheet music it scrolls across.
  const colCls =
    'contents lg:block lg:w-[8rem] lg:shrink-0 lg:z-50' +
    ' lg:sticky lg:top-[var(--app-nav-h)]';

  const layout = (
    <>
      {header(
        <span className="flex shrink-0 items-center gap-3">
          {song.conversationId && song.sheetMusic && (
            <Link
              href={`/notes/${song.conversationId}/live`}
              onClick={onNavigate}
              className="py-4 hover:text-fg"
            >
              Live
            </Link>
          )}
          {/* The same glyphs the kebabs use, so the pencil and the chain mean
              one thing wherever they appear. */}
          {song.conversationId && (
            <Link
              href={`/notes/${song.conversationId}/edit`}
              onClick={onNavigate}
              aria-label="Edit song"
              title="Edit song"
              className="py-4 px-2 hover:text-fg"
            >
              <PencilIcon size={18} />
            </Link>
          )}
          {/* Copies whatever this screen is showing: a setlist link carrying
              the position when practising a set (the address is kept in step
              above), the song's own link otherwise. */}
          {(shareUrl || song.conversationId) && (
            <button
              type="button"
              onClick={() =>
                void share(
                  shareUrl ?? songHref(song.conversationId!),
                  shareUrl ? 'Setlist' : 'Song',
                )
              }
              aria-label={
                shareUrl
                  ? 'Copy a link to this set'
                  : 'Copy a link to this song'
              }
              title="Share"
              className="py-4 px-2 hover:text-fg"
            >
              <LinkIcon size={18} />
            </button>
          )}
        </span>,
      )}

      {/* Full width, above both columns: the rail is far too narrow for a
          title flanked by two buttons. Not sticky — it scrolls away with the
          page, leaving the player pinned on its own. */}
      <div className="flex items-center justify-between gap-2 px-2">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={!canBack}
          aria-label="Previous song"
          className={navBtn}
        >
          <span aria-hidden="true">‹</span>
        </button>

        {/* In the rail the title and Edit stack, so the title keeps its
              width instead of fighting the button for it. */}
        <span className="flex min-w-0 items-center gap-3">
          <SetlistNav
            songs={songs.map((s) => ({
              title: s.title,
              isMarker: !s.conversationId,
            }))}
            current={current}
            onSelect={setIndex}
            align="center"
          >
            <span className="text-sm">
              <span className="font-medium">
                <SongTitle
                  title={song.title}
                  originalArtist={song.originalArtist}
                />
              </span>
              <span className="minor-text-theme-colors">
                {' '}
                - {current + 1}/{total}
              </span>
            </span>
          </SetlistNav>
        </span>

        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
          disabled={!canForward}
          aria-label="Next song"
          className={navBtn}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className={rowCls}>
        {song.conversationId && hasAudio && (
          <div className={colCls}>
            <AudioPlayer
              src={
                song.src ??
                `/api/conversations/${song.conversationId}/files/audio?name=${encodeURIComponent(
                  song.title,
                )}`
              }
              fileName={song.title}
              mimeType={song.mimeType ?? 'audio/mpeg'}
              conversationId={song.conversationId}
              versions={song.audioVersions}
              originalArtist={song.originalArtist}
              bpm={song.bpm}
              songKey={song.songKey}
              variant={isDesktop ? 'rail' : 'bar'}
              sticky
            />
          </div>
        )}

        <div className={mainCls}>
          {/* A song can exist before its audio does ("Create song without
              audio"), and this screen is where that song now lives. Say so
              rather than showing a player wired to a file that isn't there. */}
          {song.conversationId && !hasAudio && (
            <p className="mb-4 rounded-md border border-line px-3 py-6 text-center text-sm minor-text-theme-colors">
              No audio yet. Add audio from the Edit song page.
            </p>
          )}
          {song.conversationId ? (
            <SheetMusic
              bandId={bandId}
              conversationId={song.conversationId}
              apiKey={apiKey}
              initial={song.sheetMusic}
              startClosed={false}
              zoomKey={song.conversationId}
            />
          ) : (
            <div className="flex flex-col items-center justify-center border-t border-b border-dashed border-line-strong py-16 text-center lg:mr-4 lg:ml-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Break
              </p>
              <p className="mt-1 text-lg font-medium">{song.title}</p>
            </div>
          )}
        </div>
      </div>

      {/* Comments last, under the full width of both columns. Inside the
          provider below, so clicking a comment's timestamp scrubs the player
          that's on screen; keyed by song so stepping the set loads that
          song's thread rather than keeping the last one's. */}
      {song.conversationId && currentUserId && (
        <div className="px-4 pt-6">
          <NotesPanel
            key={song.conversationId}
            conversationId={song.conversationId}
            currentUserId={currentUserId}
            canCloseConversation={canCloseConversation}
            initialThreadId={initialThreadId ?? null}
          />
        </div>
      )}
    </>
  );

  // The provider owns the audio engine our player registers; keyed by song so
  // each one gets a fresh engine.
  return song.conversationId ? (
    <PlayerProvider key={song.conversationId}>{layout}</PlayerProvider>
  ) : (
    layout
  );
}
