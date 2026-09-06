'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createAudioEngine, type AudioEngine } from '@/lib/audio';
import { claimAudioFocus, subscribeAudioFocus } from './audioFocus';
import { MiniPlayer } from './MiniPlayer';
import { useMediaSession } from './useMediaSession';
import {
  advance,
  hasNextIndex,
  previousIndex,
  type RepeatMode,
} from './queueOrder';

/** One queued item. Any page can build these and call `play`. */
export type PlaylistTrack = {
  /** Stable id (the conversation id for songs) — used to highlight the row. */
  id: string;
  /** What the player displays. */
  title: string;
  /** Range-capable audio URL. */
  src: string;
  /** Original file name — the engine's most reliable format hint. */
  fileName?: string;
  mimeType?: string;
  /** Where clicking the title in the player goes, if anywhere. */
  href?: string;
  /** Optional line under the title (e.g. the band or upload day). */
  subtitle?: string;
  /** Who the song is originally by, shown above the subtitle for covers. */
  originalArtist?: string;
  /** Tempo / musical key, carried through so Practice can show them. */
  bpm?: number | null;
  songKey?: string | null;
  /** Known length in seconds, shown in the queue list when available. */
  durationSec?: number;
};

type PlaylistPlayerValue = {
  queue: PlaylistTrack[];
  index: number;
  /** The playing (or paused) track; null when nothing is queued. */
  track: PlaylistTrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
  /** Load `tracks` and start at `startIndex`. Replaces any current queue. */
  play: (tracks: PlaylistTrack[], startIndex?: number) => void;
  /**
   * Load `tracks`, switch shuffle on, and start somewhere random in them.
   *
   * The queue keeps the order it was given — shuffle is a traversal mode, not
   * a rearrangement — so turning shuffle off afterwards plays the list as it
   * was handed over, and the shuffle button reflects what's happening.
   */
  playShuffled: (tracks: PlaylistTrack[]) => void;
  /**
   * Append `tracks` to the end of the queue without interrupting playback.
   * With nothing queued they become the queue, loaded but paused.
   */
  enqueue: (tracks: PlaylistTrack[]) => void;
  /**
   * Move the track at `from` to `to`, keeping whatever is playing playing —
   * the position of the current track follows it.
   */
  reorder: (from: number, to: number) => void;
  /**
   * Drop the track at `index`. Removing one that isn't playing doesn't disturb
   * playback; removing the playing one moves on to what followed it (or the
   * new last track), and emptying the queue dismisses the player.
   */
  remove: (index: number) => void;
  toggle: () => void;
  next: () => void;
  /** Restart the track, or step back when already near its start. */
  previous: () => void;
  /**
   * Whether `next` has anywhere to go. Not `index + 1 < queue.length` — under
   * shuffle the queue is walked out of order, so this is "anything left
   * unplayed this pass", which callers can't derive from the index alone.
   */
  hasNext: boolean;
  /**
   * Play the queue in a random order rather than front to back. Affects `next`,
   * `previous`, and the roll-on at the end of a track; the queue itself keeps
   * its order, so the list on screen doesn't rearrange under the user.
   */
  shuffle: boolean;
  toggleShuffle: () => void;
  /**
   * `all` starts over when the queue (or shuffle pass) is spent; `one` replays
   * the current track when it ends. Cycles off → all → one.
   */
  repeat: RepeatMode;
  cycleRepeat: () => void;
  seek: (sec: number) => void;
  /**
   * Jump to a queue position without changing what the player is doing — a
   * paused queue stays paused, a playing one keeps playing on the new track.
   * (`play` always starts playback; this is for stepping through a set.)
   */
  goTo: (index: number) => void;
  /** Playback speed, 1 = normal. Carries across tracks until changed. */
  rate: number;
  setRate: (rate: number) => void;
  /** False until the current track's duration is known (i.e. still loading). */
  isReady: boolean;
  /**
   * False for the first render only, until the queue saved by the last session
   * has been restored (or found absent). An empty queue means nothing is
   * queued only once this is true.
   */
  hydrated: boolean;
  /**
   * The signed-in user's id (the session's `sub`, which is the database id),
   * or null when signed out.
   *
   * Exposed here because the layout has already resolved the session and this
   * provider wraps the whole app: surfaces that need to know who's looking —
   * the comments panel, wherever it's embedded — can read it without their own
   * route going dynamic. `/practice` is a precached static shell, so it can't
   * fetch a user of its own.
   */
  currentUserId: string | null;
  /**
   * Stop playback and take the bar off the screen. The queue is kept — playing
   * anything (here or from another surface's controls) brings the bar back.
   */
  close: () => void;
};

const PlaylistPlayerContext = createContext<PlaylistPlayerValue | null>(null);

/** Name this player claims when it takes over playback. */
const FOCUS_OWNER = 'playlist';

/** Pressing "previous" past this point restarts the track instead. */
const RESTART_THRESHOLD_SEC = 3;

/** Where the queue is kept between sessions. */
const SAVED_QUEUE_KEY = 'playlistQueue';
/** Bump when `PlaylistTrack` changes shape; older payloads are then dropped. */
const SAVED_QUEUE_VERSION = 1;
/**
 * Upper bound on what we'll write. A queue this long is already unusual, and
 * the cap keeps one runaway "add everything" from filling the origin's quota.
 */
const MAX_SAVED_TRACKS = 300;

interface SavedQueue {
  v: number;
  /** Whose queue this is — see `readSavedQueue`. */
  u: string | null;
  index: number;
  queue: PlaylistTrack[];
  /** 1 when the bar was dismissed — the queue survives, hidden. */
  d?: 1;
}

/** A stored entry is only usable if it still has what the engine needs. */
function isPlayableTrack(t: unknown): t is PlaylistTrack {
  const o = t as PlaylistTrack | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.src === 'string' &&
    o.src.length > 0
  );
}

/**
 * The queue `userKey` last left behind, or null. Anything unreadable, stale,
 * or malformed is treated as "no saved queue" — a broken payload should cost
 * the user a queue, never a crash on app open.
 *
 * The queue is scoped to the user it belongs to. localStorage is per-origin,
 * not per-account, so on a shared browser someone else's saved queue would
 * otherwise show up (with song titles) after they signed out. A key mismatch
 * both refuses the queue and deletes it.
 */
function readSavedQueue(
  userKey: string | null,
): { queue: PlaylistTrack[]; index: number; dismissed: boolean } | null {
  try {
    const raw = localStorage.getItem(SAVED_QUEUE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedQueue;
    if (!parsed || parsed.v !== SAVED_QUEUE_VERSION) return null;
    if (!userKey) return null; // signed out — nothing here is ours to restore
    if (parsed.u !== userKey) {
      localStorage.removeItem(SAVED_QUEUE_KEY);
      return null;
    }
    const queue = Array.isArray(parsed.queue)
      ? parsed.queue.filter(isPlayableTrack)
      : [];
    if (queue.length === 0) return null;
    // Clamp rather than reject: dropping an unplayable entry shifts the rest.
    const index =
      Number.isInteger(parsed.index) && parsed.index >= 0
        ? Math.min(parsed.index, queue.length - 1)
        : 0;
    return { queue, index, dismissed: parsed.d === 1 };
  } catch {
    return null;
  }
}

/**
 * Global playlist player.
 *
 * Owns one audio engine for the current track and rebuilds it whenever the
 * track changes, auto-advancing through the queue on end. Mounted once in the
 * root layout: any page can queue tracks through `usePlaylistPlayer()`, and
 * the `MiniPlayer` bar appears at the bottom of the screen while something is
 * queued and the bar hasn't been dismissed — playback survives navigation
 * because the provider lives above the router's children.
 *
 * The queue also survives the app closing: it's mirrored to localStorage on
 * every change and restored (paused, on the same track, and still dismissed if
 * it was) at the next open. Dismissing stops playback and hides the bar but
 * keeps the queue; it only empties when its last track is removed.
 */
export function PlaylistPlayerProvider({
  userKey,
  children,
}: {
  /**
   * Stable id of the signed-in user (`session.user.sub`), or null when signed
   * out. Scopes the saved queue so it only ever comes back for its owner.
   */
  userKey: string | null;
  children: ReactNode;
}) {
  const [queue, setQueue] = useState<PlaylistTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  // Bar dismissed by the user. The queue is untouched and still playable from
  // anywhere that has its own controls — this only takes the bar off screen.
  const [dismissed, setDismissed] = useState(false);

  const engineRef = useRef<AudioEngine | null>(null);
  // Read from `onReady`, which outlives the render that set the speed: each
  // new engine starts at 1x and has to be told the speed the user picked.
  const rateRef = useRef(1);
  // Src the live engine was built for, so `play` can tell "resume this track"
  // from "load a different one".
  const currentSrcRef = useRef<string | null>(null);
  // Whether to start playing as soon as the engine reports ready. Set when the
  // user asked for playback (pressed play, skipped, or auto-advanced).
  const wantPlayRef = useRef(false);
  // Latest queue/end handler, read from engine callbacks that outlive renders.
  const queueRef = useRef<PlaylistTrack[]>([]);
  const onEndRef = useRef<() => void>(() => {});
  // Don't let the mount pass — when the queue is still empty — erase what the
  // last session saved before the restore below has had a chance to read it.
  const skipSaveRef = useRef(true);
  // `isPlaying` for the callbacks that outlive the render that set it — `toggle`
  // and the Media Session handlers, which must stay stable.
  const isPlayingRef = useRef(false);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  /**
   * The live index, for the transport callbacks.
   *
   * They used to reach it through a functional `setIndex`, which can't work
   * for shuffle: choosing the next track has to record the one being left, and
   * a state updater that mutates something isn't pure — React would run it
   * twice in development (Strict Mode) and remember the departure twice.
   * Kept in step here instead, and updated as each move is made so two quick
   * presses don't both read the same starting point.
   */
  const indexRef = useRef(0);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  const [shuffle, setShuffle] = useState(false);
  const shuffleRef = useRef(false);
  /**
   * Tracks already reached in this shuffle pass, oldest first — what stops a
   * shuffle repeating itself, and what `previous` walks back through.
   *
   * Ids rather than positions: the queue can be reordered or have entries
   * removed mid-pass, which would silently repoint every stored position. An
   * id that's no longer in the queue is simply skipped. (A queue holding the
   * same track twice marks both played at once — rare, and the alternative
   * costs the robustness above.)
   */
  const [shuffleHistory, setShuffleHistory] = useState<string[]>([]);
  const shuffleHistoryRef = useRef<string[]>([]);

  /** Write both at once, the way `queue`/`queueRef` are kept in step. */
  const setHistory = useCallback((ids: string[]) => {
    shuffleHistoryRef.current = ids;
    setShuffleHistory(ids);
  }, []);

  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const repeatRef = useRef<RepeatMode>('off');

  const cycleRepeat = useCallback(() => {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    const nextMode =
      order[(order.indexOf(repeatRef.current) + 1) % order.length]!;
    repeatRef.current = nextMode;
    setRepeat(nextMode);
  }, []);

  const track = queue[index] ?? null;
  const src = track?.src ?? null;

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Bring back the queue the app was closed with, once, on mount.
  //
  // Read here rather than in a lazy `useState` initializer: localStorage
  // doesn't exist on the server, and a queue present at first client render
  // but absent in the server's HTML would be a hydration mismatch (the bar
  // renders only when something is queued).
  //
  // Restoring never starts audio — `wantPlayRef` stays false. Browsers block
  // autoplay without a gesture anyway, and a phone that starts playing on its
  // own when the app opens would be worse than useless on stage.
  useEffect(() => {
    // Batched with whatever this pass restores, so consumers never see the
    // "settled but empty" state for a frame.
    setHydrated(true);
    // A page that queued something in its own mount effect wins: child effects
    // run before the parent's, so this would otherwise clobber a fresh queue.
    if (queueRef.current.length > 0) return;
    const saved = readSavedQueue(userKey);
    if (!saved) return;
    queueRef.current = saved.queue;
    setQueue(saved.queue);
    setIndex(saved.index);
    // A bar dismissed last session stays dismissed — restoring it would undo
    // the one thing the user asked for.
    setDismissed(saved.dismissed);
    // Mount-only: a `userKey` change means a different session entirely, which
    // arrives as a fresh page load anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save on every change, so the queue survives however the app goes away —
  // a swipe-closed PWA and a crashed tab never get an unload event.
  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    try {
      if (queue.length === 0) {
        // Emptied (the last track removed) — nothing left worth restoring.
        localStorage.removeItem(SAVED_QUEUE_KEY);
        return;
      }
      const payload: SavedQueue = {
        v: SAVED_QUEUE_VERSION,
        u: userKey,
        index,
        queue: queue.slice(0, MAX_SAVED_TRACKS),
        ...(dismissed ? { d: 1 as const } : {}),
      };
      localStorage.setItem(SAVED_QUEUE_KEY, JSON.stringify(payload));
    } catch {
      // Private mode or a full quota — playback carries on regardless.
    }
  }, [queue, index, userKey, dismissed]);

  // Build an engine per track. The cleanup destroys it, so changing tracks (or
  // closing the player) never leaves a Howl holding an HTML5 audio slot.
  useEffect(() => {
    if (!src) {
      currentSrcRef.current = null;
      return;
    }
    setError(null);
    setCurrentTime(0);
    setDuration(0);

    const engine = createAudioEngine({
      url: src,
      mimeType: track?.mimeType ?? 'audio/mpeg',
      fileName: track?.fileName ?? track?.title,
      onReady: (dur) => {
        setDuration(dur);
        engine.setRate(rateRef.current);
        if (wantPlayRef.current) {
          engine.play();
          setIsPlaying(true);
        }
      },
      onEnd: () => onEndRef.current(),
      onError: (err) => {
        setError(
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'Playback error',
        );
        setIsPlaying(false);
      },
      onSeek: (sec) => setCurrentTime(sec),
      // Playback changed without going through this app — a Bluetooth or
      // headset button, a car head unit, an incoming call. Follow it, so the
      // button reflects what's actually happening and `toggle` does the right
      // thing on the next tap. `wantPlayRef` moves too: it's what a track
      // change consults, and an externally paused player shouldn't start
      // playing again just because the queue advanced.
      onPlayStateChange: (playing) => {
        wantPlayRef.current = playing;
        setIsPlaying(playing);
        // Resuming from a headset with the bar dismissed should bring it back,
        // the same as pressing play in the app does.
        if (playing) setDismissed(false);
      },
    });
    engineRef.current = engine;
    currentSrcRef.current = src;

    let destroyed = false;
    const teardown = () => {
      if (destroyed) return;
      destroyed = true;
      engine.destroy();
      if (engineRef.current === engine) {
        engineRef.current = null;
        currentSrcRef.current = null;
      }
    };
    // Mobile browsers can unload the page without running React cleanup;
    // `pagehide` (non-bfcache) forces teardown so the audio slot is released.
    const handlePageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) teardown();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      teardown();
    };
    // `track` is only read for its format hints, which belong to this src.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Tick the elapsed time while playing. Like the single-song player, this
  // loop never reads `engine.isPlaying()` — a seek briefly reports paused.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const loop = () => {
      const engine = engineRef.current;
      if (!engine) return;
      setCurrentTime(engine.getCurrentTime());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  /** Where the queue goes after `from` — see app/player/queueOrder.ts. */
  const advanceFrom = useCallback(
    (from: number) =>
      advance(
        queueRef.current,
        from,
        shuffleHistoryRef.current,
        shuffleRef.current,
        repeatRef.current === 'all',
      ),
    [],
  );

  /** Move to `target`, remembering the departure so `previous` can undo it. */
  const stepTo = useCallback(
    (from: number, target: number, resetPass = false) => {
      if (shuffleRef.current) {
        const leaving = queueRef.current[from];
        // A new pass starts from this track alone; otherwise remember where we
        // came from so `previous` can walk back.
        setHistory(
          resetPass
            ? leaving
              ? [leaving.id]
              : []
            : leaving
              ? [...shuffleHistoryRef.current, leaving.id]
              : shuffleHistoryRef.current,
        );
      }
      indexRef.current = target;
      wantPlayRef.current = true;
      setIndex(target);
    },
    [setHistory],
  );

  const next = useCallback(() => {
    const from = indexRef.current;
    const move = advanceFrom(from);
    if (!move) return;
    stepTo(from, move.target, move.resetPass);
  }, [advanceFrom, stepTo]);

  // End of a track: replay it under repeat-one, otherwise roll on — or stop
  // when the queue (or shuffle pass) is spent, leaving the bar up so it can be
  // replayed.
  useEffect(() => {
    onEndRef.current = () => {
      if (repeatRef.current === 'one') {
        const engine = engineRef.current;
        engine?.seek(0);
        setCurrentTime(0);
        engine?.play();
        wantPlayRef.current = true;
        setIsPlaying(true);
        return;
      }
      const from = indexRef.current;
      const move = advanceFrom(from);
      if (!move) {
        wantPlayRef.current = false;
        setIsPlaying(false);
        return;
      }
      stepTo(from, move.target, move.resetPass);
    };
  }, [advanceFrom, stepTo]);

  const play = useCallback(
    (tracks: PlaylistTrack[], startIndex = 0) => {
      const target = tracks[startIndex];
      if (!target) return;
      claimAudioFocus(FOCUS_OWNER);
      // Audio the user can't see the controls for is worse than no bar.
      setDismissed(false);
      queueRef.current = tracks;
      setQueue(tracks);
      indexRef.current = startIndex;
      setIndex(startIndex);
      // A new list is a new shuffle pass; the old one's history describes tracks
      // that may not even be here any more.
      setHistory([]);
      wantPlayRef.current = true;
      // Same audio as the live engine — the song we land on is the one already
      // loaded (playing this track again, or picking a set whose first song is
      // the one playing). The src effect won't re-run, so start it here, from
      // the top: `play` means "start this list", not "adopt whatever this song
      // was already doing 2:30 in".
      if (engineRef.current && currentSrcRef.current === target.src) {
        engineRef.current.seek(0);
        setCurrentTime(0);
        engineRef.current.play();
        setIsPlaying(true);
      }
    },
    [setHistory],
  );

  const playShuffled = useCallback(
    (tracks: PlaylistTrack[]) => {
      if (tracks.length === 0) return;
      // Set the mode before starting, so the first track is already part of a
      // shuffled pass rather than the head of an ordered one. `play` clears the
      // pass history, so there's nothing stale to carry in.
      shuffleRef.current = true;
      setShuffle(true);
      play(tracks, Math.floor(Math.random() * tracks.length));
    },
    [play],
  );

  const enqueue = useCallback((tracks: PlaylistTrack[]) => {
    if (tracks.length === 0) return;
    // Adding to a hidden queue should show it — otherwise the action looks
    // like it did nothing.
    setDismissed(false);
    setQueue((prev) => {
      const nextQueue = [...prev, ...tracks];
      // Keep the ref in step for the callbacks that read it (end-of-track,
      // next) before the next render commits.
      queueRef.current = nextQueue;
      return nextQueue;
    });
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    setQueue((prev) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= prev.length ||
        to >= prev.length
      ) {
        return prev;
      }
      const nextQueue = [...prev];
      const moved = nextQueue.splice(from, 1)[0];
      if (!moved) return prev;
      nextQueue.splice(to, 0, moved);
      queueRef.current = nextQueue;
      return nextQueue;
    });
    // Follow the playing track to its new slot. The track object (and so its
    // src) is unchanged, so the engine isn't rebuilt and audio keeps going.
    setIndex((i) => {
      if (from === to) return i;
      if (i === from) return to;
      if (from < i && to >= i) return i - 1;
      if (from > i && to <= i) return i + 1;
      return i;
    });
  }, []);

  const pausePlayback = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.pause();
    wantPlayRef.current = false;
    setIsPlaying(false);
  }, []);

  const resumePlayback = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    claimAudioFocus(FOCUS_OWNER);
    setDismissed(false);
    engine.play();
    wantPlayRef.current = true;
    setIsPlaying(true);
  }, []);

  /**
   * Branches on our own state rather than `engine.isPlaying()`.
   *
   * Howler's flag only records what *it* was told to do, so after anything
   * paused the audio from outside the app it still reports playing — and this
   * would then pause an already-paused track, taking two taps to get going
   * again. `isPlaying` is kept true to the element by `onPlayStateChange`
   * below, which makes it the honest thing to ask.
   */
  const toggle = useCallback(() => {
    if (isPlayingRef.current) pausePlayback();
    else resumePlayback();
  }, [pausePlayback, resumePlayback]);

  const previous = useCallback(() => {
    const engine = engineRef.current;
    const elapsed = engine?.getCurrentTime() ?? 0;
    const restart = () => {
      engine?.seek(0);
      setCurrentTime(0);
    };
    if (elapsed > RESTART_THRESHOLD_SEC) {
      restart();
      return;
    }

    // Shuffled, "back" means where the pass actually came from, not the
    // position before this one. Entries removed from the queue since are
    // skipped rather than treated as the end of the road.
    if (shuffleRef.current) {
      const back = previousIndex(queueRef.current, shuffleHistoryRef.current);
      if (!back) {
        setHistory([]);
        restart();
        return;
      }
      setHistory(back.history);
      indexRef.current = back.target;
      wantPlayRef.current = true;
      setIndex(back.target);
      return;
    }

    const from = indexRef.current;
    if (from === 0) {
      restart();
      return;
    }
    indexRef.current = from - 1;
    wantPlayRef.current = true;
    setIndex(from - 1);
  }, [setHistory]);

  const seek = useCallback((sec: number) => {
    const engine = engineRef.current;
    if (!engine || !Number.isFinite(sec)) return;
    engine.seek(sec);
    setCurrentTime(sec);
  }, []);

  const remove = useCallback((target: number) => {
    const prev = queueRef.current;
    if (target < 0 || target >= prev.length) return;
    const nextQueue = prev.filter((_, i) => i !== target);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    if (nextQueue.length === 0) {
      // Nothing left to play — same end state as dismissing the player.
      wantPlayRef.current = false;
      setIsPlaying(false);
      setIndex(0);
      setCurrentTime(0);
      setDuration(0);
      setError(null);
      return;
    }
    // Keep pointing at the same track. Removing the one that's playing lands
    // on whatever followed it, and the src change starts it if we were playing
    // (`wantPlayRef` is untouched either way).
    setIndex((i) => {
      if (target > i) return i;
      if (target < i) return i - 1;
      return Math.min(i, nextQueue.length - 1);
    });
  }, []);

  // Step to another track in place. Unlike `play`, this leaves `wantPlayRef`
  // alone, so the new track picks up whatever the player was already doing.
  const goTo = useCallback(
    (target: number) => {
      const q = queueRef.current;
      const from = indexRef.current;
      if (target === from || target < 0 || target >= q.length) return;
      // Still a track change, so a shuffle pass counts it — otherwise a manual
      // jump could be handed straight back by the next random pick.
      if (shuffleRef.current) {
        const leaving = q[from];
        if (leaving) setHistory([...shuffleHistoryRef.current, leaving.id]);
      }
      indexRef.current = target;
      setIndex(target);
    },
    [setHistory],
  );

  /**
   * Both directions start a fresh pass: switching shuffle on shouldn't count
   * what was already played against it, and switching it off leaves nothing
   * worth remembering.
   */
  const toggleShuffle = useCallback(() => {
    const on = !shuffleRef.current;
    shuffleRef.current = on;
    setShuffle(on);
    setHistory([]);
  }, [setHistory]);

  const setRate = useCallback((r: number) => {
    rateRef.current = r;
    setRateState(r);
    engineRef.current?.setRate(r);
  }, []);

  // Stop and get off the screen — but keep the queue. What was lined up is
  // still lined up (the Practice screen, the Song queue tab), and playing any
  // of it brings the bar back.
  const close = useCallback(() => {
    wantPlayRef.current = false;
    engineRef.current?.pause();
    setIsPlaying(false);
    setDismissed(true);
  }, []);

  // Another player took over (a song page hit play) — yield and pause.
  useEffect(
    () =>
      subscribeAudioFocus(FOCUS_OWNER, () => {
        wantPlayRef.current = false;
        engineRef.current?.pause();
        setIsPlaying(false);
      }),
    [],
  );

  const getPosition = useCallback(
    () => engineRef.current?.getCurrentTime() ?? 0,
    [],
  );

  // From state, and deliberately not via `nextIndexFrom` — that picks at
  // random, so asking it during a render would answer differently each time.
  const hasNext = hasNextIndex(
    queue,
    index,
    shuffleHistory,
    shuffle,
    repeat === 'all',
  );

  // Hands the OS the transport controls. Registering these is what stops the
  // browser acting on the audio element behind our back when a media key
  // arrives — see the hook's header.
  const mediaActions = useMemo(
    () => ({
      play: resumePlayback,
      pause: pausePlayback,
      next,
      previous,
      seek,
      stop: close,
      getPosition,
    }),
    [resumePlayback, pausePlayback, next, previous, seek, close, getPosition],
  );

  useMediaSession({
    track,
    isPlaying,
    duration,
    rate,
    canNext: hasNext,
    canPrevious: queue.length > 0,
    actions: mediaActions,
  });

  const value: PlaylistPlayerValue = {
    queue,
    index,
    track,
    isPlaying,
    currentTime,
    duration,
    error,
    play,
    playShuffled,
    enqueue,
    reorder,
    remove,
    toggle,
    next,
    previous,
    hasNext,
    shuffle,
    toggleShuffle,
    repeat,
    cycleRepeat,
    seek,
    goTo,
    rate,
    setRate,
    isReady: duration > 0,
    hydrated,
    currentUserId: userKey,
    close,
  };

  return (
    <PlaylistPlayerContext.Provider value={value}>
      {children}
      {track && !dismissed && (
        <>
          {/* Keeps the fixed bar from covering the end of the page. */}
          <div aria-hidden="true" className="h-28" />
          <MiniPlayer currentUserId={userKey} />
        </>
      )}
    </PlaylistPlayerContext.Provider>
  );
}

/**
 * Queue and control the global player. Safe to call from any client component
 * under the root layout.
 */
export function usePlaylistPlayer(): PlaylistPlayerValue {
  const ctx = useContext(PlaylistPlayerContext);
  if (!ctx) {
    throw new Error(
      'usePlaylistPlayer must be used within PlaylistPlayerProvider',
    );
  }
  return ctx;
}
