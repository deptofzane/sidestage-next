'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioEngine, type AudioEngine } from '@/lib/audio';
import { formatDuration, formatSongMeta } from '@/lib/format';
import { useTrackBoolean } from '../../PendingActionProvider';
import { claimAudioFocus, subscribeAudioFocus } from '../../player/audioFocus';
import { usePlayer } from './PlayerContext';
import { LoadingBar } from '../../Spinner';
import { RestartIcon } from '../../player/icons';
import { ActionMenu, ActionMenuItem } from '../../ActionMenu';
import {
  parseSpeedPercent,
  ratePercent,
  SPEED_MAX,
  SPEED_MIN,
} from '@/lib/playback-speed';

/** One selectable audio version, for the in-player version switcher. */
export type PlayerVersion = {
  id: string;
  fileName: string;
  mimeType: string;
  label: string | null;
  isDefault: boolean;
};

type AudioPlayerProps = {
  /** URL the audio streams from (Range-capable). */
  src: string;
  fileName: string;
  mimeType: string;
  /** Stick the player to the top of the viewport while scrolling. */
  sticky?: boolean;
  /**
   * Optional multi-version support. When two or more versions are passed
   * (along with `conversationId`), the options panel shows a version
   * switcher and the player streams the selected version instead of `src`.
   */
  conversationId?: string;
  versions?: PlayerVersion[];
  // Practice options refer to the 10s forward and backup, as well as the ability to adjust speed
  hasPracticeOptions?: boolean;
  /**
   * The song's tempo and musical key, shown in the options panel when known.
   * `songKey` rather than `key` — React reserves `key` as a prop name and
   * would swallow it before the component ever saw it.
   */
  bpm?: number | null;
  songKey?: string | null;
  /** Who the song is originally by — shown by the rail variant, for covers. */
  originalArtist?: string | null;
  /**
   * `bar` is the horizontal player. `rail` is the Practice page's desktop
   * form: a narrow vertical strip that leaves the sheet music its width.
   */
  variant?: 'bar' | 'rail';
};

/** Name this player claims when it takes over playback (see `audioFocus`). */
const FOCUS_OWNER = 'song';

/** Remembers whether the playback-options panel is expanded, across pages. */
const OPTIONS_OPEN_KEY = 'audioPlayer.optionsOpen';

/**
 * Client-side audio player.
 *
 * Owns one `AudioEngine` (Howler instance) for the file's lifetime in
 * this view. Uses a `requestAnimationFrame` loop while playing to
 * update the displayed current time — gentler on the CPU than a
 * `setInterval` and lines up naturally with the browser's paint cycle.
 *
 * When `externalEngineRef` is passed in (Phase 5+), the engine is also
 * exposed through that ref so the notes panel can seek to a note's
 * timestamp and read the current time when composing.
 */
export function AudioPlayer({
  src,
  fileName,
  mimeType,
  sticky = false,
  conversationId,
  versions,
  hasPracticeOptions = true,
  bpm,
  songKey,
  originalArtist,
  variant = 'bar',
}: AudioPlayerProps) {
  const { setEngine } = usePlayer();
  const engineRef = useRef<AudioEngine | null>(null);
  // Last play/pause toggle time, for the 100ms debounce (guards against a
  // held/repeated key or a double-tap rapidly flipping playback).
  const lastToggleRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(1);

  // Version switching. When versions are supplied, the player streams the
  // selected one (defaulting to the version flagged `isDefault`); otherwise
  // it falls back to the `src`/`fileName`/`mimeType` props.
  const hasVersions = Boolean(
    conversationId && versions && versions.length > 0,
  );
  // Only the user's explicit pick is state; the rest derives from the props.
  // Storing the resolved id instead would freeze it at mount — and since
  // returning from Edit song re-renders this component rather than remounting
  // it, a version made default over there would never take effect here.
  const [override, setOverride] = useState<string | null>(null);

  // Drop that pick whenever the version set changes underneath us. Adjusted
  // during render rather than in an effect: an effect would paint one frame
  // with the stale selection, and on this component that means a frame of the
  // wrong audio loading.
  const versionKey =
    versions?.map((v) => `${v.id}:${v.isDefault}`).join('|') ?? '';
  const [seenVersionKey, setSeenVersionKey] = useState(versionKey);
  if (versionKey !== seenVersionKey) {
    setSeenVersionKey(versionKey);
    setOverride(null);
  }

  // Default before first: deleting the selected version should fall back to
  // the song's default, not to whichever version happens to sort first. Only
  // ids and default-ness are in the key above, so renaming a version leaves an
  // explicit pick alone.
  const selectedVersion = hasVersions
    ? (versions!.find((v) => v.id === override) ??
      versions!.find((v) => v.isDefault) ??
      versions![0]!)
    : null;

  const effectiveSrc = selectedVersion
    ? `/api/conversations/${conversationId}/files/audio?version=${
        selectedVersion.id
      }&name=${encodeURIComponent(selectedVersion.fileName)}`
    : src;
  const effectiveFileName = selectedVersion
    ? selectedVersion.label || selectedVersion.fileName
    : fileName;
  const effectiveMimeType = selectedVersion
    ? selectedVersion.mimeType
    : mimeType;

  // Show the global pending indicator while the audio is loading. The
  // condition flips off as soon as Howler reports readiness or an
  // error, so the spinner clears at the same moment the "Loading
  // audio…" inline message disappears.
  useTrackBoolean(!isReady && !error);

  // Spin up the engine on mount. Tear it down on unmount.
  //
  // Mobile Firefox can navigate away from the page without running
  // React's effect cleanup (e.g. swipe-back triggering bfcache, or a
  // fast page-replace before unmount). When that happens, the Howler
  // instance leaks its slot in `Howler.html5PoolSize`. After a few
  // such navigations the pool exhausts and new audio refuses to load.
  // The `pagehide` listener below catches the case where the page is
  // being fully unloaded (`persisted=false`) and forces teardown then,
  // so the slot is released. We skip teardown when `persisted=true`
  // because that means the browser is freezing the page into bfcache
  // and will restore it — destroying the engine there would break
  // playback on restoration.
  useEffect(() => {
    setIsReady(false);
    setError(null);
    setCurrentTime(0);
    // A source change (navigation OR a version switch) tears down the old
    // engine and builds a fresh, paused one — reset play state so the
    // toggle icon and the rAF tick loop don't chase a stale engine.
    setIsPlaying(false);

    const engine = createAudioEngine({
      // `src` carries a `?name=` hint so the serve route can recover a
      // concrete `audio/*` Content-Type when the stored MIME is generic
      // (Firefox mobile is strict about that header).
      url: effectiveSrc,
      mimeType: effectiveMimeType,
      fileName: effectiveFileName,
      onReady: (dur) => {
        setDuration(dur);
        setIsReady(true);
      },
      onEnd: () => {
        setIsPlaying(false);
      },
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
      // Keep React state in sync after any seek — manual (slider) or
      // programmatic (note timestamp clicks via PlayerContext). Without
      // this, the rAF loop is the only thing pushing currentTime into
      // state, and it only runs while playing — so a seek-while-paused
      // would leave the seek bar visually stuck.
      onSeek: (sec) => setCurrentTime(sec),
    });
    engineRef.current = engine;
    setEngine(engine); // share with the notes panel via PlayerContext

    let destroyed = false;
    const teardown = () => {
      if (destroyed) return;
      destroyed = true;
      engine.destroy();
      // Guarded clear: by the time a pagehide-triggered teardown runs,
      // React may have already remounted with a new engine. Don't null
      // out a ref/context that points at someone else.
      if (engineRef.current === engine) {
        engineRef.current = null;
        setEngine(null);
      }
    };

    const handlePageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) teardown();
    };
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      teardown();
    };
  }, [effectiveSrc, effectiveFileName, effectiveMimeType, setEngine]);

  // Tick the current-time display while playing.
  //
  // Important: this loop intentionally does NOT inspect
  // `engine.isPlaying()` to decide whether to stop. During a seek
  // (slider drag or programmatic via PlayerContext), Howler's
  // underlying <audio> element briefly fires `pause` before resuming
  // at the new position. `isPlaying()` returns false for that frame
  // or two, and an earlier version of this loop would mirror that
  // into `isPlaying` state — flipping the icon to "play" even though
  // the user never paused. The source of truth for play/pause state
  // is user intent (the toggle button) plus genuine stop events
  // (`onEnd`, `onError`). The rAF loop just ticks the timestamp.
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

  const togglePlay = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !isReady) return;
    // Debounce: ignore toggles within 100ms of the last one.
    const now = Date.now();
    if (now - lastToggleRef.current < 100) return;
    lastToggleRef.current = now;
    if (engine.isPlaying()) {
      engine.pause();
      setIsPlaying(false);
    } else {
      // Take over playback so the global playlist player pauses.
      claimAudioFocus(FOCUS_OWNER);
      engine.play();
      setIsPlaying(true);
    }
  }, [isReady]);

  // The playlist player (or another song) started — pause so they don't
  // overlap.
  useEffect(
    () =>
      subscribeAudioFocus(FOCUS_OWNER, () => {
        if (engineRef.current?.isPlaying()) {
          engineRef.current.pause();
          setIsPlaying(false);
        }
      }),
    [],
  );

  const seekTo = useCallback((t: number) => {
    const engine = engineRef.current;
    if (!engine || !Number.isFinite(t)) return;
    engine.seek(t);
    setCurrentTime(t);
  }, []);

  const back10 = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !isReady) return;
    const t = Math.max(0, engine.getCurrentTime() - 10);
    engine.seek(t);
    setCurrentTime(t);
  }, [isReady]);

  const forward10 = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !isReady) return;
    const max = duration || engine.getCurrentTime() + 10;
    const t = Math.min(max, engine.getCurrentTime() + 10);
    engine.seek(t);
    setCurrentTime(t);
  }, [isReady, duration]);

  const startOver = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !isReady) return;
    engine?.seek(0);
    setCurrentTime(0);
  }, [isReady]);

  useTransportKeys({ togglePlay, forward10, back10 });

  // Apply the selected speed — on change, and again after each (re)load,
  // since a new engine starts at 1x.
  useEffect(() => {
    if (isReady) engineRef.current?.setRate(rate);
  }, [isReady, rate]);

  return (
    <AudioPlayerView
      fileName={effectiveFileName}
      currentTime={currentTime}
      duration={duration}
      isPlaying={isPlaying}
      isReady={isReady}
      error={error}
      sticky={sticky}
      bpm={bpm}
      songKey={songKey}
      originalArtist={originalArtist}
      variant={variant}
      onTogglePlay={togglePlay}
      onSeek={seekTo}
      practice={
        hasPracticeOptions
          ? {
              rate,
              onRateChange: setRate,
              onStartOver: startOver,
              onBack10: back10,
              onForward10: forward10,
            }
          : undefined
      }
      versions={
        hasVersions
          ? {
              list: versions!,
              selectedId: selectedVersion!.id,
              onSelect: setOverride,
            }
          : undefined
      }
    />
  );
}

/**
 * Space = play/pause, ← / → = 10s back/forward.
 *
 * Ignored while a *text or value* control is focused, so typing, the seek
 * slider (where arrows natively scrub) and selects keep their own behaviour.
 *
 * Buttons and links are deliberately not excluded. Almost everything on the
 * Practice screen is a button — play, the song steppers, the options toggle,
 * the kebab — and focus stays on whatever you last clicked, so excluding them
 * meant the arrows went dead after the first click and never came back.
 * Arrows do nothing on a focused button or link natively, so there's nothing
 * to displace. Space is still excluded for buttons below, since that *does*
 * activate them.
 */
function useTransportKeys({
  togglePlay,
  forward10,
  back10,
}: {
  togglePlay: () => void;
  forward10: () => void;
  back10: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t?.isContentEditable;
      if (typing) return;
      if (e.key === ' ' || e.code === 'Space') {
        // A focused button or link handles space itself; hijacking it would
        // both toggle playback and press the control.
        if (tag === 'BUTTON' || tag === 'A') return;
        if (e.repeat) return; // don't retrigger while the key is held
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        forward10();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back10();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, forward10, back10]);
}

/**
 * The speed field, shared by both player layouts so the clamping is written
 * once.
 *
 * Typing is held in local state and only committed on blur or Enter: clamping
 * every keystroke makes the field impossible to type in — clearing it to type
 * "150" would snap to the minimum on the first digit. Escape abandons the
 * edit. A junk value falls back to whatever was showing rather than resetting
 * to 100, which would silently discard a speed someone had set.
 */
function SpeedInput({
  rate,
  onRateChange,
  disabled,
  className,
}: {
  rate: number;
  onRateChange: (rate: number) => void;
  disabled: boolean;
  className: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    setDraft(null);
    const next = parseSpeedPercent(raw);
    if (next !== null) onRateChange(next);
  };

  return (
    <span className="flex items-center gap-0.5">
      <input
        type="number"
        inputMode="numeric"
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={5}
        value={draft ?? String(ratePercent(rate))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          } else if (e.key === 'Escape') {
            setDraft(null);
          }
        }}
        disabled={disabled}
        aria-label={`Playback speed, percent. ${SPEED_MIN} to ${SPEED_MAX}.`}
        title="Playback speed"
        className={className}
      />
      <span aria-hidden="true" className="text-xs text-neutral-500">
        %
      </span>
    </span>
  );
}

/** Stacked layers: this song's other audio versions. */
function VersionsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

/**
 * The Practice page's desktop player: a narrow vertical strip instead of a
 * horizontal bar, so the sheet music beside it keeps the width.
 *
 * An info box over two columns — playback progress running top-to-bottom on
 * the left, the controls stacked on the right. The slider is a real range
 * input turned upright with `writing-mode`, so it stays draggable and
 * keyboard-operable; rotating one with a transform would have kept the looks
 * and lost both.
 */
function AudioPlayerRail({
  fileName,
  originalArtist,
  bpm,
  songKey,
  currentTime,
  duration,
  isPlaying,
  isReady,
  error,
  onTogglePlay,
  onSeek,
  practice,
  versions,
}: {
  fileName: string;
  originalArtist?: string | null;
  bpm?: number | null;
  songKey?: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isReady: boolean;
  error: string | null;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  practice?: {
    rate: number;
    onRateChange: (rate: number) => void;
    onStartOver: () => void;
    onBack10: () => void;
    onForward10: () => void;
  };
  versions?: {
    list: PlayerVersion[];
    selectedId: string;
    onSelect: (id: string) => void;
  };
}) {
  const songMeta = formatSongMeta(bpm ?? null, songKey ?? null);
  const hasVersionSwitcher = Boolean(versions && versions.list.length > 1);
  const ctrl =
    'flex h-9 w-full items-center justify-center rounded-md border border-line-strong text-xs font-medium text-fg-soft hover:bg-surface-soft disabled:opacity-40';

  return (
    // IN PROGRESS
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 h-fit">
      {/* Info box */}
      <div className="flex flex-col gap-0.5">
        <h2 className="truncate text-sm font-medium" title={fileName}>
          {fileName}
        </h2>
        {originalArtist && (
          <p className="truncate text-xs minor-text-theme-colors">
            Originally by {originalArtist}
          </p>
        )}
        {songMeta && (
          <p className="text-xs minor-text-theme-colors">{songMeta}</p>
        )}
      </div>

      {error ? (
        <p className="rounded-md border border-danger-line bg-danger-fill px-2 py-1.5 text-xs text-danger-strong">
          {error}
        </p>
      ) : (
        <div className="flex gap-3">
          {/* Progress, running top to bottom */}
          <div className="flex flex-col items-center gap-1 h-[28rem]">
            <span className="font-mono text-[0.6875rem] tabular-nums minor-text-theme-colors">
              {formatDuration(currentTime)}
            </span>
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
              disabled={!isReady || duration <= 0}
              aria-label="Seek"
              aria-orientation="vertical"
              // `vertical-lr` puts the track's zero at the top, so progress
              // fills downward the way the song reads.
              className="h-[16rem] w-4 flex-1 accent-blue-600 [writing-mode:vertical-lr]"
            />
            <span className="font-mono text-[0.6875rem] tabular-nums minor-text-theme-colors">
              {formatDuration(duration)}
            </span>
          </div>

          {/* Controls */}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={!isReady}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              title={isPlaying ? 'Pause' : 'Play'}
              className="flex h-9 w-full items-center justify-center rounded-md bg-blue-600 text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {isPlaying ? (
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {practice && (
              <>
                <button
                  type="button"
                  onClick={practice.onStartOver}
                  disabled={!isReady}
                  aria-label="Start over"
                  title="Start over"
                  className={ctrl}
                >
                  <RestartIcon />
                </button>
                <button
                  type="button"
                  onClick={practice.onForward10}
                  disabled={!isReady}
                  aria-label="Forward 10 seconds"
                  title="Forward 10 seconds"
                  className={ctrl}
                >
                  10s<span aria-hidden="true">↻</span>
                </button>
                <button
                  type="button"
                  onClick={practice.onBack10}
                  disabled={!isReady}
                  aria-label="Back 10 seconds"
                  title="Back 10 seconds"
                  className={ctrl}
                >
                  <span aria-hidden="true">↺</span>10s
                </button>
                {/* The rail is narrow, so the field is sized to three digits
                    and the % sits outside it. */}
                <span className="flex w-full items-center justify-center gap-0.5">
                  <SpeedInput
                    rate={practice.rate}
                    onRateChange={practice.onRateChange}
                    disabled={!isReady}
                    className="h-9 w-12 rounded-md border border-line-strong bg-transparent text-center text-xs font-medium text-fg-soft disabled:opacity-40"
                  />
                </span>
              </>
            )}

            {hasVersionSwitcher && (
              <ActionMenu
                label="Audio version"
                align="left"
                triggerClassName={ctrl}
                icon={
                  <span title="Audio version" className="flex items-center">
                    <VersionsIcon />
                  </span>
                }
              >
                <p
                  role="presentation"
                  className="px-4 pb-1 pt-1 text-xs font-medium minor-text-theme-colors sm:px-3"
                >
                  Versions:
                </p>
                {versions!.list.map((v) => (
                  <ActionMenuItem
                    key={v.id}
                    onClick={() => versions!.onSelect(v.id)}
                  >
                    {/* The check marks the one playing; the space keeps the
                        others' text aligned with it. */}
                    {(v.id === versions!.selectedId ? '✓ ' : '\u2007 ') +
                      (v.label || v.fileName) +
                      (v.isDefault ? ' (default)' : '')}
                  </ActionMenuItem>
                ))}
              </ActionMenu>
            )}
          </div>
        </div>
      )}

      {!isReady && !error && <LoadingBar label="Loading audio" />}
    </div>
  );
}

/**
 * The player's controls, with no audio engine of its own — the caller owns
 * playback and passes state down. Used by `AudioPlayer` (one song, its own
 * engine) and by the full-screen player's Practice tab, which drives the
 * shared queue engine instead, so both show the same bar.
 */
export function AudioPlayerView({
  fileName,
  currentTime,
  duration,
  isPlaying,
  isReady,
  error,
  sticky = false,
  bpm,
  songKey,
  originalArtist,
  variant = 'bar',
  onTogglePlay,
  onSeek,
  practice,
  versions,
}: {
  fileName: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  /** False while the audio is still loading — controls stay disabled. */
  isReady: boolean;
  error: string | null;
  sticky?: boolean;
  /** Tempo / musical key, shown in the options panel when either is set. */
  bpm?: number | null;
  songKey?: string | null;
  originalArtist?: string | null;
  /** See `AudioPlayerProps.variant`. */
  variant?: 'bar' | 'rail';
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  /** Start over / ±10s / speed. Omit to hide the practice options entirely. */
  practice?: {
    rate: number;
    onRateChange: (rate: number) => void;
    onStartOver: () => void;
    onBack10: () => void;
    onForward10: () => void;
  };
  /** In-player version switcher; only shown when there's more than one. */
  versions?: {
    list: PlayerVersion[];
    selectedId: string;
    onSelect: (id: string) => void;
  };
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Hydrate the panel's open/closed state from localStorage after mount.
  // Reading in a `useEffect` (rather than a lazy initializer) keeps the
  // server-rendered markup deterministic, avoiding a hydration mismatch.
  useEffect(() => {
    try {
      if (localStorage.getItem(OPTIONS_OPEN_KEY) === '1') setOptionsOpen(true);
    } catch {
      // localStorage may be unavailable (private mode / SSR); ignore.
    }
  }, []);

  const toggleOptions = useCallback(() => {
    setOptionsOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(OPTIONS_OPEN_KEY, next ? '1' : '0');
      } catch {
        // Ignore persistence failures; state still updates in-memory.
      }
      return next;
    });
  }, []);

  const hasVersionSwitcher = Boolean(versions && versions.list.length > 1);
  const songMeta = formatSongMeta(bpm ?? null, songKey ?? null);

  // The rail is a different shape, not a restyled bar — the controls it shows
  // are always open, so it has no options panel and ignores the state above.
  if (variant === 'rail')
    return (
      <AudioPlayerRail
        fileName={fileName}
        originalArtist={originalArtist}
        bpm={bpm}
        songKey={songKey}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        isReady={isReady}
        error={error}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
        practice={practice}
        versions={versions}
      />
    );

  return (
    <div
      className={
        'border border-line p-4' +
        (sticky ? ' sticky top-0 z-30 bg-surface' : '')
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="truncate text-sm font-medium lg:max-w-[16rem] ">
          {fileName}
        </h2>
        <span className="shrink-0 font-mono text-xs tabular-nums minor-text-theme-colors">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!isReady}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-500 disabled:opacity-50"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            // Pause icon
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            // Play icon
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

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
          disabled={!isReady || duration <= 0}
          className="flex-1 accent-blue-600"
          aria-label="Seek"
        />

        {(practice || hasVersionSwitcher) && (
          <button
            type="button"
            onClick={toggleOptions}
            aria-expanded={optionsOpen}
            aria-controls="audio-player-options"
            aria-label="Playback options"
            title="Playback options"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg-dim hover:bg-surface-soft"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={
                'transition-transform' + (optionsOpen ? ' rotate-180' : '')
              }
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>

      {optionsOpen && (practice || hasVersionSwitcher) && (
        <div
          id="audio-player-options"
          className="mt-3 flex flex-wrap items-center gap-4 border-t border-line pt-3"
        >
          {practice && (
            <>
              <button
                type="button"
                onClick={practice.onStartOver}
                disabled={!isReady}
                aria-label="Start over"
                title="Start over"
                className="flex h-9 shrink-0 items-center gap-0.5 rounded-full border border-line-strong px-2.5 text-xs font-medium text-fg-soft hover:bg-surface-soft disabled:opacity-50"
              >
                <span aria-hidden="true">Start over</span>
              </button>

              <button
                type="button"
                onClick={practice.onBack10}
                disabled={!isReady}
                aria-label="Back 10 seconds"
                title="Back 10 seconds"
                className="flex h-9 shrink-0 items-center gap-0.5 rounded-full border border-line-strong px-2.5 text-xs font-medium text-fg-soft hover:bg-surface-soft disabled:opacity-50"
              >
                <span aria-hidden="true">↺</span>10s
              </button>

              <button
                type="button"
                onClick={practice.onForward10}
                disabled={!isReady}
                aria-label="Forward 10 seconds"
                title="Forward 10 seconds"
                className="flex h-9 shrink-0 items-center gap-0.5 rounded-full border border-line-strong px-2.5 text-xs font-medium text-fg-soft hover:bg-surface-soft disabled:opacity-50"
              >
                10s<span aria-hidden="true">↻</span>
              </button>

              <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                Speed
                <SpeedInput
                  rate={practice.rate}
                  onRateChange={practice.onRateChange}
                  disabled={!isReady}
                  className="w-14 shrink-0 rounded-md border border-line-strong bg-surface px-1.5 py-1 text-xs disabled:opacity-50"
                />
              </span>
            </>
          )}

          {hasVersionSwitcher && (
            <label className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
              Version
              <select
                value={versions!.selectedId}
                onChange={(e) => versions!.onSelect(e.target.value)}
                aria-label="Audio version"
                title="Audio version"
                className="min-w-0 max-w-[10rem] truncate rounded-md border border-line-strong bg-surface px-1.5 py-1 text-xs"
              >
                {versions!.list.map((v) => (
                  <option key={v.id} value={v.id}>
                    {(v.label || v.fileName) +
                      (v.isDefault ? ' (default)' : '')}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* `ml-auto` rather than `justify-between` on the row: the panel
              wraps, and only this needs to sit at the right edge. */}
          {songMeta && (
            <span className="ml-auto shrink-0 text-xs text-fg-muted">
              {songMeta}
            </span>
          )}
        </div>
      )}

      {!isReady && !error && (
        <LoadingBar className="mt-4" label="Loading audio" />
      )}
      {error && (
        <p className="mt-3 rounded-md border border-danger-line bg-danger-fill px-3 py-2 text-xs text-danger-strong">
          {error}
        </p>
      )}
    </div>
  );
}
