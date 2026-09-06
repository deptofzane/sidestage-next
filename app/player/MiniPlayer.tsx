'use client';

import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/format';
import { FullPlayer } from './FullPlayer';
import { usePlaylistPlayer, type PlaylistTrack } from './PlaylistPlayer';
import { useIsDesktop } from '../useIsDesktop';
import { RestartIcon } from './icons';

/** Horizontal travel that commits a drag to a track change. */
const SWIPE_PX = 56;
/** Travel before a gesture is claimed as a swipe rather than a scroll or tap. */
const CLAIM_PX = 8;
/** How far the bar follows the finger — enough to read the next song's row. */
const MAX_DRAG_PX = 160;
/** Length of the commit slide. Must match `duration-200` on the strip. */
const SLIDE_MS = 200;

// Shared by the live row and its neighbours, so a track sliding into place
// lands exactly where the real one is drawn.
const PLAY_BTN_CLS =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-500';
const ICON_BTN_CLS =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-dim hover:bg-surface-hover disabled:opacity-40';
const ROW_CLS = 'flex w-full items-center gap-3 px-3 py-2 lg:px-6';
const TIME_CLS =
  'shrink-0 font-mono text-[0.6875rem] tabular-nums minor-text-theme-colors';

function PlayPauseIcon({ isPlaying }: { isPlaying: boolean }) {
  return isPlaying ? (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/** Title, queue position, elapsed/total and the progress line. */
function TrackColumn({
  title,
  originalArtist,
  subtitle,
  position,
  total,
  currentTime,
  duration,
  error,
  onSeek,
}: {
  title: string;
  originalArtist?: string;
  subtitle?: string;
  position: number;
  total: number;
  currentTime: number;
  duration: number;
  error?: string | null;
  /**
   * Given, the progress line becomes a scrub bar. Only desktop passes one:
   * on a phone the bar is a thumb-sized swipe target, and a slider inside it
   * would fight the gesture for the same drag.
   */
  onSeek?: (seconds: number) => void;
}) {
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        {/* Plain text, not a link: on a phone this sits inside the swipe
            target, where a link is a trap for the thumb. The full player
            links out to the track. */}
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        {total > 1 && (
          <span className="shrink-0 text-xs tabular-nums minor-text-theme-colors">
            {position} of {total}
          </span>
        )}
      </div>

      {error ? (
        <p className="truncate text-xs text-danger">{error}</p>
      ) : (
        <div className="flex items-center gap-2">
          <span className={TIME_CLS}>{formatDuration(currentTime)}</span>
          {onSeek ? (
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={(e) => {
                const t = parseFloat(e.target.value);
                if (Number.isFinite(t)) onSeek(t);
              }}
              disabled={duration <= 0}
              aria-label="Seek"
              className="h-1 min-w-0 flex-1 accent-blue-600"
            />
          ) : (
            <div
              role="progressbar"
              aria-label="Playback progress"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration) || 0}
              aria-valuenow={Math.round(currentTime)}
              aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration)}`}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-strong"
            >
              <div
                className="h-full rounded-full bg-blue-600"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <span className={TIME_CLS}>{formatDuration(duration)}</span>
        </div>
      )}
      {/* Above the subtitle, which is where tempo and key land. */}
      {originalArtist && !error && (
        <p className="truncate text-[0.6875rem] minor-text-theme-colors">
          Originally by {originalArtist}
        </p>
      )}
      {subtitle && !error && (
        <p className="truncate text-[0.6875rem] minor-text-theme-colors">
          {subtitle}
        </p>
      )}
    </div>
  );
}

/**
 * The track on one side of the live row, parked just off the edge of the bar.
 *
 * It's a full copy of the row rather than a label, so that a committed swipe
 * can simply slide it into place: what the user watches arrive is laid out
 * exactly like what replaces it, and the swap underneath is invisible. Inert
 * and hidden from assistive tech — the real row is a frame away.
 */
function PeekRow({
  track,
  side,
  position,
  total,
  isPlaying,
}: {
  track: PlaylistTrack;
  side: 'prev' | 'next';
  position: number;
  total: number;
  isPlaying: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={
        'pointer-events-none absolute inset-y-0 ' +
        (side === 'prev' ? 'right-full ' : 'left-full ') +
        ROW_CLS
      }
    >
      <div className="flex shrink-0 items-center gap-1">
        <span className={PLAY_BTN_CLS}>
          <PlayPauseIcon isPlaying={isPlaying} />
        </span>
        <span className={ICON_BTN_CLS}>
          <RestartIcon />
        </span>
      </div>
      <TrackColumn
        title={track.title}
        originalArtist={track.originalArtist}
        subtitle={track.subtitle}
        position={position}
        total={total}
        // A track you haven't reached (or are stepping back to) starts at zero.
        currentTime={0}
        duration={track.durationSec ?? 0}
      />
      {/* Placeholders for expand and dismiss, so the columns line up. */}
      <span className="h-9 w-9 shrink-0" />
      <span className="h-9 w-9 shrink-0" />
    </div>
  );
}

/**
 * The playback bar pinned to the bottom of the screen while something is
 * queued. Shows the track name, its place in the queue, playback progress,
 * and play-pause / restart / expand / dismiss controls.
 *
 * The two sizes change tracks differently. Desktop has Previous and Next
 * buttons and a draggable scrub bar. A phone has neither: the bar is too
 * narrow for four transport buttons, and a slider that thin is a poor thumb
 * target — so there it's a swipe, left for the next song and right for the
 * previous, with the neighbouring tracks parked just off either edge so a
 * committed swipe carries through as one motion. Both are always a move,
 * never a restart of what's playing, which is what the Restart button is for.
 *
 * The expand button is the only way into the full-screen `FullPlayer` — the
 * bar's background isn't a target, so a stray tap can't take over the screen.
 * Rendered by `PlaylistPlayerProvider`; pages never mount it themselves.
 */
export function MiniPlayer({
  currentUserId,
}: {
  /** Signed-in user's id, for the comments panel in the full-screen player. */
  currentUserId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dragX, setDragX] = useState(0);
  /** A swipe that met the threshold, sliding out on its way to `target`. */
  const [commit, setCommit] = useState<{
    side: 'prev' | 'next';
    target: number;
  } | null>(null);
  /** The frame after a commit lands, when the strip snaps back untweened. */
  const [settling, setSettling] = useState(false);
  const {
    track,
    queue,
    index,
    isPlaying,
    currentTime,
    duration,
    error,
    toggle,
    goTo,
    seek,
    close,
  } = usePlaylistPlayer();

  // Desktop gets Previous/Next buttons and a scrub bar instead of the swipe:
  // a draggable slider inside a swipe target would fight it for the drag, and
  // with buttons present the gesture has nothing left to do.
  const isDesktop = useIsDesktop();

  const start = useRef<{ x: number; y: number } | null>(null);
  /** The pointer we've taken capture of, once the drag reads as horizontal. */
  const captured = useRef<number | null>(null);
  /** Set when a gesture resolved to a swipe, to disarm the click it leaves. */
  const swiped = useRef(false);

  // Change the track only once the outgoing row has finished sliding off, so
  // the neighbour the user watched arrive is the one that stays.
  useEffect(() => {
    if (!commit) return;
    const timer = setTimeout(() => {
      goTo(commit.target);
      setSettling(true);
      setCommit(null);
    }, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [commit, goTo]);

  // Re-arm the transition a frame after the untweened snap back to centre has
  // painted — any sooner and the browser animates the snap itself, undoing it.
  useEffect(() => {
    if (!settling) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSettling(false));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [settling]);

  if (!track) return null;

  if (expanded)
    return (
      <FullPlayer
        onCollapse={() => setExpanded(false)}
        currentUserId={currentUserId}
      />
    );

  const prevTrack = index > 0 ? (queue[index - 1] ?? null) : null;
  const nextTrack =
    index + 1 < queue.length ? (queue[index + 1] ?? null) : null;

  const endGesture = (e: React.PointerEvent) => {
    if (captured.current !== null) {
      // Guarded: releasing a capture the element no longer holds throws.
      if (e.currentTarget.hasPointerCapture(captured.current))
        e.currentTarget.releasePointerCapture(captured.current);
      captured.current = null;
    }
    start.current = null;
    setDragX(0);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    // Mid-commit the strip is animating; a new drag would fight it.
    if (isDesktop || !e.isPrimary || commit) return;
    start.current = { x: e.clientX, y: e.clientY };
    swiped.current = false;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s || !e.isPrimary) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;

    if (captured.current === null) {
      // Undecided: a mostly-vertical drag belongs to the page's scroll, so
      // let go of it entirely rather than competing for the gesture.
      if (Math.abs(dy) > Math.abs(dx)) {
        start.current = null;
        return;
      }
      if (Math.abs(dx) < CLAIM_PX) return;
      // Committed — capture so the drag survives leaving the bar's bounds.
      e.currentTarget.setPointerCapture(e.pointerId);
      captured.current = e.pointerId;
    }
    setDragX(dx);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    const wasDragging = captured.current !== null;
    endGesture(e);
    if (!s || !e.isPrimary || !wasDragging) return;

    const dx = e.clientX - s.x;
    if (Math.abs(dx) < SWIPE_PX) return; // Short of committing — leave it be.
    const side = dx < 0 ? 'next' : 'prev';
    const target = dx < 0 ? index + 1 : index - 1;
    if (side === 'next' ? !nextTrack : !prevTrack) return;

    swiped.current = true;
    // `goTo`, not the player's `previous`: a swipe is a request to change
    // songs, and hearing the current one start over would read as a miss.
    if (
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    ) {
      goTo(target);
      setSettling(true);
      return;
    }
    setCommit({ side, target });
  };

  // Runs ahead of every control in the bar: a drag that happens to end over
  // the play button should not also toggle playback, and none of them should
  // expand the player.
  const handleClickCapture = (e: React.MouseEvent) => {
    if (!swiped.current) return;
    swiped.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // Clamped so the strip stops short of a full change of its own accord, and
  // damped at either end of the queue where there's no neighbour to reveal —
  // the bar shouldn't promise a move it won't make.
  const clamped = Math.max(-MAX_DRAG_PX, Math.min(MAX_DRAG_PX, dragX));
  const blocked = clamped < 0 ? !nextTrack : !prevTrack;
  const offset = blocked ? clamped / 4 : clamped;

  // A commit runs the strip the rest of the way, landing the peek exactly
  // where the live row sits.
  const transform = commit
    ? `translateX(${commit.side === 'next' ? '-100%' : '100%'})`
    : offset === 0
      ? undefined
      : `translateX(${offset}px)`;
  // No transition while the finger is down (the strip tracks it exactly) or
  // on the snap back to centre after a commit (that one must not be seen).
  const tweened = dragX === 0 && !settling;

  // The player zeroes its clock in an effect, which lands a frame after the
  // swap paints — long enough to flash the outgoing track's elapsed time
  // against the incoming title. `settling` marks exactly that gap.
  const engineDuration = settling ? 0 : duration;
  const shownTime = settling ? 0 : currentTime;
  // Falling back to the queue's own length keeps the total from blinking to
  // 0:00 while the new track loads — and matches what the peek showed.
  const shownDuration =
    engineDuration > 0 ? engineDuration : (track.durationSec ?? 0);

  return (
    <div
      role="region"
      aria-label="Audio player"
      // `.player-bar` anchors it above the nav on mobile, and to the bottom
      // edge on desktop where the nav sits at the top.
      className="player-bar fixed inset-x-0 z-40 border-t border-line bg-white/95 backdrop-blur dark:bg-neutral-900/95"
    >
      {/* Clips to the bar's own width, so the parked neighbours stay hidden
          until a drag uncovers them. */}
      <div className="mx-auto max-w-5xl overflow-hidden">
        <div
          onClickCapture={handleClickCapture}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={endGesture}
          style={transform ? { transform } : undefined}
          // `touch-pan-y` keeps vertical scrolling with the page while
          // claiming horizontal drags for the swipe.
          className={
            'relative touch-pan-y select-none ' +
            ROW_CLS +
            (tweened ? ' transition-transform duration-200' : '')
          }
        >
          {prevTrack && !isDesktop && (
            <PeekRow
              track={prevTrack}
              side="prev"
              position={index}
              total={queue.length}
              isPlaying={isPlaying}
            />
          )}

          <div className="flex shrink-0 items-center gap-1">
            {isDesktop && (
              <button
                type="button"
                onClick={() => prevTrack && goTo(index - 1)}
                disabled={!prevTrack}
                aria-label="Previous song"
                title="Previous song"
                className={ICON_BTN_CLS}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M7 6h2v12H7zM19 6v12l-9-6z" />
                </svg>
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              title={isPlaying ? 'Pause' : 'Play'}
              className={PLAY_BTN_CLS}
            >
              <PlayPauseIcon isPlaying={isPlaying} />
            </button>

            {/* Restart, not "previous": swiping right steps back a track, so
                starting the current one over needs its own control. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                seek(0);
              }}
              disabled={engineDuration <= 0}
              aria-label="Restart song"
              title="Restart song"
              className={ICON_BTN_CLS}
            >
              <RestartIcon />
            </button>

            {isDesktop && (
              <button
                type="button"
                onClick={() => nextTrack && goTo(index + 1)}
                disabled={!nextTrack}
                aria-label="Next song"
                title="Next song"
                className={ICON_BTN_CLS}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M15 6h2v12h-2zM5 6l9 6-9 6z" />
                </svg>
              </button>
            )}
          </div>

          <TrackColumn
            title={track.title}
            originalArtist={track.originalArtist}
            subtitle={track.subtitle}
            position={index + 1}
            total={queue.length}
            currentTime={shownTime}
            duration={shownDuration}
            error={error}
            onSeek={isDesktop ? seek : undefined}
          />

          {/* Redundant with tapping the bar, but the only way to expand from a
              keyboard — and the visible cue that the bar opens at all. */}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Expand player"
            title="Expand player"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full minor-text-theme-colors hover:bg-surface-hover hover:text-fg-strong"
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
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            aria-label="Close player"
            title="Close player"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full minor-text-theme-colors hover:bg-surface-hover hover:text-fg-strong"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>

          {nextTrack && !isDesktop && (
            <PeekRow
              track={nextTrack}
              side="next"
              position={index + 2}
              total={queue.length}
              isPlaying={isPlaying}
            />
          )}
        </div>
      </div>
    </div>
  );
}
