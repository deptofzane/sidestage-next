'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useNavigate } from '../../../useNavigate';
import { ActionMenu, ActionMenuItem } from '../../../ActionMenu';
import { PlayShuffleRow } from '../../../player/PlayShuffleRow';
import { useEnqueueTracks } from '../../../player/useEnqueueTracks';
import { MinimizeToggle } from '../bandDetailShared';
import { useBandUploads } from '../bandDetailHooks';
import { dayLabel, groupByDay, timeLabel, uploadTrack } from './uploadDays';
import { usePlaylistPlayer } from '../../../player/PlaylistPlayer';
import { LoadMore } from '../../../LoadMore';
import { LoadingBlock } from '../../../Spinner';
import { SongTitle } from '../../../SongTitle';

/**
 * The Uploads tab: the band's audio files grouped by the day they arrived,
 * newest day first, collapsing into one entry per day with a kebab for
 * day-level actions.
 *
 * Files, not songs: a second take of an existing song is an upload and belongs
 * here, while a song created without audio never was one. Read-only — per-song
 * actions live on the Songs tab.
 *
 * Loads its own pages rather than taking the list as a prop: this component is
 * only mounted while its tab is open, which is what keeps the band's whole
 * upload history off every other tab's load. A page can land mid-day, so the
 * oldest day on screen may be partial until "Load more" fills it in — the
 * per-day page always fetches its own day whole.
 */
export function UploadHistory({ bandId }: { bandId: string }) {
  const {
    items: uploads,
    hasMore,
    loadingMore,
    error,
    loadMore,
  } = useBandUploads(bandId);
  const go = useNavigate();
  const player = usePlaylistPlayer();
  const enqueue = useEnqueueTracks();
  /**
   * Days the user has toggled away from their default, rather than the open
   * ones. The default is "the newest day is open, older ones aren't", and the
   * day list arrives after this mounts — so there's no moment at which a set
   * of open days could be seeded. Tracking the exceptions needs no seeding.
   */
  const [toggled, setToggled] = useState<Set<string>>(new Set());

  const toggleDay = (key: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (error) {
    return (
      <p className="rounded-md border border-danger-line bg-danger-fill px-3 py-2 text-sm text-danger-strong">
        {error}
      </p>
    );
  }

  if (!uploads) return <LoadingBlock label="Loading uploads" />;

  if (uploads.length === 0) {
    return (
      <p className="rounded-md border border-line px-3 py-6 text-center text-sm minor-text-theme-colors">
        Nothing uploaded yet. Audio you add shows up here, grouped by day.
      </p>
    );
  }

  return (
    <>
      <LoadMore
        shown={uploads.length}
        noun="upload"
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={() => void loadMore()}
      />
      <ul className="flex flex-col gap-3">
        {groupByDay(uploads).map(([key, dayUploads], dayIndex) => {
          // `groupByDay` is newest first, so index 0 is the latest upload day.
          const open = (dayIndex === 0) !== toggled.has(key);
          return (
            <li key={key} className="rounded-lg border border-line">
              <div className="flex items-center justify-between gap-2 px-1">
                <MinimizeToggle
                  minimized={!open}
                  onToggle={() => toggleDay(key)}
                  label={dayLabel(key)}
                >
                  <h2 className="text-sm font-medium">{dayLabel(key)}</h2>
                </MinimizeToggle>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-xs minor-text-theme-colors">
                    {dayUploads.length}{' '}
                    {dayUploads.length === 1 ? 'upload' : 'uploads'}
                  </span>
                  <ActionMenu label={`Actions for ${dayLabel(key)}`}>
                    {/* Every row here is an audio file, so the whole day is
                    playable — no need to filter the way a setlist does. */}
                    <PlayShuffleRow
                      label={dayLabel(key)}
                      onPlay={() => player.play(dayUploads.map(uploadTrack), 0)}
                      onShuffle={() =>
                        player.playShuffled(dayUploads.map(uploadTrack))
                      }
                      onQueue={() =>
                        enqueue(dayUploads.map(uploadTrack), 'this day')
                      }
                    />
                    <ActionMenuItem
                      onClick={() =>
                        go(`/bands/${bandId}/audio/uploads/${key}`)
                      }
                    >
                      View tracks
                    </ActionMenuItem>
                  </ActionMenu>
                </div>
              </div>
              {open && (
                <ul className="divide-y divide-line border-t border-line">
                  {dayUploads.map((u) => (
                    <li
                      key={u.fileId}
                      className="flex items-center gap-2 pr-3 hover:bg-surface-soft"
                    >
                      <Link
                        href={`/notes/${u.conversationId}/practice?from=audio`}
                        className="min-w-0 flex-1 px-4 py-3 text-sm md:px-3 md:py-1.5"
                      >
                        <SongTitle
                          title={u.title}
                          originalArtist={u.originalArtist}
                        />
                        {/* The file, so two takes of one song are tellable apart. */}
                        <span className="block truncate text-xs minor-text-theme-colors">
                          {u.label || u.fileName}
                        </span>
                      </Link>
                      <span className="shrink-0 text-xs tabular-nums minor-text-theme-colors">
                        {timeLabel(u.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
