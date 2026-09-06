'use client';

import { useEffect } from 'react';
import { appIcons } from '@/lib/app-icons';
import type { PlaylistTrack } from './PlaylistPlayer';

/**
 * Publish the current track to the OS, and take its transport controls.
 *
 * Two jobs, and the first is what makes the second work. Registering action
 * handlers is what stops the browser applying its *default* response to a
 * media key — which is to play or pause the underlying element behind our
 * back, leaving the UI showing the opposite of what's happening. With handlers
 * registered, a Bluetooth or headset button runs the same code path as tapping
 * the on-screen control, so there's one source of truth again.
 *
 * The metadata half is what a phone in a pocket or a car head unit shows:
 * title, band, and artwork on the lock screen instead of a bare "playing".
 *
 * Everything here is feature-detected. Media Session is absent on some
 * browsers and partially implemented on others, and `setActionHandler` throws
 * `TypeError` for actions the browser doesn't know — so each is registered
 * individually and a rejection of one can't take the rest down.
 */

type MediaSessionActions = {
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek: (sec: number) => void;
  stop: () => void;
  /** Live position, read at handler time rather than passed per frame. */
  getPosition: () => number;
};

/** Default jump for `seekforward`/`seekbackward` when the OS names no offset. */
const SEEK_STEP_SEC = 10;

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function useMediaSession({
  track,
  isPlaying,
  duration,
  rate,
  canNext,
  canPrevious,
  actions,
}: {
  track: PlaylistTrack | null;
  isPlaying: boolean;
  duration: number;
  rate: number;
  canNext: boolean;
  canPrevious: boolean;
  actions: MediaSessionActions;
}) {
  // What the lock screen shows. Artwork is the installed-app icon, which is
  // already the right shape for this and is the mark people associate with the
  // app; both sizes are offered so the OS can pick.
  useEffect(() => {
    if (!supported()) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      // The cover's original artist when there is one, else whatever the queue
      // labelled the row with (the band, or the upload day).
      artist: track.originalArtist ?? track.subtitle ?? '',
      album: track.subtitle ?? '',
      artwork: [
        { src: appIcons.icon192, sizes: '192x192', type: 'image/png' },
        { src: appIcons.icon512, sizes: '512x512', type: 'image/png' },
      ],
    });
  }, [track]);

  useEffect(() => {
    if (!supported()) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  /**
   * The scrubber and elapsed time on the lock screen.
   *
   * Set on the things that change the shape of playback, never per tick: the
   * OS extrapolates position from `playbackRate` on its own, so feeding it
   * every animation frame would be pure overhead. `setPositionState` throws if
   * the numbers aren't coherent (non-finite duration, position past the end),
   * which happens routinely while a track is still loading — hence the guard.
   */
  useEffect(() => {
    if (!supported() || !navigator.mediaSession.setPositionState) return;
    if (!Number.isFinite(duration) || duration <= 0) {
      navigator.mediaSession.setPositionState();
      return;
    }
    const position = Math.min(Math.max(actions.getPosition(), 0), duration);
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate > 0 ? rate : 1,
        position,
      });
    } catch {
      // Incoherent numbers mid-load; the next change will set it correctly.
    }
    // `actions` is rebuilt each render; position is read at call time, so it
    // isn't a dependency — this should fire on playback shape changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, rate, isPlaying, track]);

  useEffect(() => {
    if (!supported()) return;
    const ms = navigator.mediaSession;

    // `null` un-registers, which is how the OS is told a control shouldn't be
    // offered — greying out next/previous at the ends of the queue.
    const handlers: Array<
      [MediaSessionAction, MediaSessionActionHandler | null]
    > = [
      ['play', () => actions.play()],
      ['pause', () => actions.pause()],
      ['stop', () => actions.stop()],
      ['nexttrack', canNext ? () => actions.next() : null],
      ['previoustrack', canPrevious ? () => actions.previous() : null],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') {
            actions.seek(details.seekTime);
          }
        },
      ],
      [
        'seekforward',
        (details) =>
          actions.seek(
            actions.getPosition() + (details.seekOffset ?? SEEK_STEP_SEC),
          ),
      ],
      [
        'seekbackward',
        (details) =>
          actions.seek(
            actions.getPosition() - (details.seekOffset ?? SEEK_STEP_SEC),
          ),
      ],
    ];

    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
        if (handler) registered.push(action);
      } catch {
        // Action unknown to this browser — the others still stand.
      }
    }

    return () => {
      for (const action of registered) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // Nothing to undo if it never took.
        }
      }
    };
  }, [actions, canNext, canPrevious]);

  /**
   * Nothing queued: clear the lock screen rather than leave a stale entry
   * whose buttons drive a player that no longer has a track.
   *
   * Declared last on purpose. Effects run in order, so this settles
   * `playbackState` after the `isPlaying` effect above — which, with nothing
   * queued, would otherwise leave it at 'paused' (an idle player) instead of
   * 'none' (no player at all).
   */
  useEffect(() => {
    if (!supported() || track) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }, [track]);
}
