'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useNavigate } from '../../../useNavigate';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import { AddTrackToSetlistModal } from '../../../player/AddTrackToSetlistModal';
import {
  usePlaylistPlayer,
  type PlaylistTrack,
} from '../../../player/PlaylistPlayer';

/**
 * The Song queue tab: what the global player has lined up, in play order.
 * Reflects the live queue wherever it was built from (this page's play
 * buttons, "Add song to queue", an event's setlist), including after the bar
 * has been dismissed — playing an entry brings it back. Clicking an entry
 * jumps straight to it; "Arrange"
 * switches to drag-to-reorder rows like the setlist editor, and reordering
 * never interrupts what's playing.
 */
export function SongQueue() {
  const { queue, index, isPlaying, track, play, toggle, reorder, remove } =
    usePlaylistPlayer();
  const [arranging, setArranging] = useState(false);
  // Queue entry whose "Add to setlist" modal is open.
  const [addTarget, setAddTarget] = useState<PlaylistTrack | null>(null);
  const go = useNavigate();
  const share = useShareLink();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (queue.length === 0) {
    return (
      <p className="rounded-md border border-line px-3 py-6 text-center text-sm minor-text-theme-colors">
        Nothing queued. Use a song’s play button, or “Add song to queue” from
        its menu, to build a queue.
      </p>
    );
  }

  const known = queue.filter((t) => t.durationSec != null);
  const totalSeconds = known.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);

  // The same song can be queued twice, so the row's position — not the track
  // id — is what identifies it to the sortable list.
  const rows = queue.map((track, i) => ({ id: `${track.id}-${i}`, track }));
  const rowIds = rows.map((r) => r.id);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = rowIds.indexOf(String(active.id));
    const to = rowIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    reorder(from, to);
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {queue.length} {queue.length === 1 ? 'song' : 'songs'} queued
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          {totalSeconds > 0 && (
            <span className="text-xs minor-text-theme-colors">
              {known.length === queue.length ? '' : '~'}
              {formatDuration(totalSeconds)}
            </span>
          )}
          {queue.length > 1 && (
            <button
              type="button"
              onClick={() => setArranging((v) => !v)}
              aria-pressed={arranging}
              className="btn-outline"
            >
              {arranging ? 'Done' : 'Arrange'}
            </button>
          )}
        </div>
      </div>

      {arranging ? (
        <>
          <p className="text-xs minor-text-theme-colors">
            Drag the handles to reorder. Playback keeps going.
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            /* Auto-scroll, gentler than the default acceleration of 10: at
               that speed a drag near the top or bottom of a phone screen runs
               away from you. The 20% edge zone is left alone. */
            autoScroll={{ acceleration: 6 }}
          >
            <SortableContext
              items={rowIds}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-2">
                {rows.map((row, i) => (
                  <SortableQueueRow
                    key={row.id}
                    id={row.id}
                    track={row.track}
                    position={i + 1}
                    isCurrent={i === index}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map(({ id: rowId, track: t }, i) => {
            const isCurrent = i === index;
            return (
              <li
                key={rowId}
                className={
                  'flex items-center gap-3 pr-1 ' +
                  (isCurrent ? 'bg-accent-fill' : '')
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    isCurrent && track ? toggle() : play(queue, i)
                  }
                  aria-label={
                    isCurrent && isPlaying
                      ? `Pause ${t.title}`
                      : `Play ${t.title}`
                  }
                  title={
                    isCurrent && isPlaying
                      ? `Pause ${t.title}`
                      : `Play ${t.title}`
                  }
                  className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong text-fg-body bg-blue-50 hover:bg-blue-100 dark:bg-blue-700 dark:hover:bg-blue-500"
                >
                  {isCurrent && isPlaying ? (
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

                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-neutral-400">
                  {i + 1}
                </span>

                <span className="min-w-0 flex-1 py-3 md:py-1.5">
                  {t.href ? (
                    <Link
                      href={t.href}
                      className={
                        'block truncate text-sm hover:underline ' +
                        (isCurrent ? 'font-medium text-accent-strong' : '')
                      }
                    >
                      {t.title}
                    </Link>
                  ) : (
                    <span
                      className={
                        'block truncate text-sm ' +
                        (isCurrent ? 'font-medium' : '')
                      }
                    >
                      {t.title}
                    </span>
                  )}
                  {t.originalArtist && (
                    <span className="block truncate text-xs minor-text-theme-colors">
                      Originally by {t.originalArtist}
                    </span>
                  )}
                  {t.subtitle && (
                    <span className="block truncate text-xs minor-text-theme-colors">
                      {t.subtitle}
                    </span>
                  )}
                </span>

                {t.durationSec != null && (
                  <span className="shrink-0 text-xs tabular-nums minor-text-theme-colors">
                    {formatDuration(t.durationSec)}
                  </span>
                )}

                <ActionMenu label={`Actions for ${t.title}`}>
                  <MenuSectionLabel>Song</MenuSectionLabel>
                  <MenuIconRow
                    items={[
                      {
                        key: 'view',
                        icon: <EyeIcon size={18} />,
                        label: `View ${t.title}`,
                        title: 'View song',
                        onClick: () => go(songHref(t.id)),
                      },
                      {
                        key: 'edit',
                        icon: <PencilIcon size={18} />,
                        label: `Edit ${t.title}`,
                        title: 'Edit song',
                        onClick: () => go(`/notes/${t.id}/edit`),
                      },
                      {
                        key: 'share',
                        icon: <LinkIcon size={18} />,
                        label: `Copy a link to ${t.title}`,
                        title: 'Share song',
                        onClick: () => void share(songHref(t.id), 'Song'),
                      },
                    ]}
                  />
                  {/* By row, not by track id: the same song can sit in the
                      queue twice, and only the one whose menu is open should
                      come out. */}
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
      )}

      {addTarget && (
        <AddTrackToSetlistModal
          track={addTarget}
          onClose={() => setAddTarget(null)}
        />
      )}
    </section>
  );
}

/**
 * A queue row while arranging: a drag handle in place of the play button,
 * styled like the setlist editor's rows. Titles aren't links here — dragging
 * and navigation don't mix.
 */
function SortableQueueRow({
  id,
  track,
  position,
  isCurrent,
}: {
  id: string;
  track: PlaylistTrack;
  position: number;
  isCurrent: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={
        'flex items-center gap-3 rounded-lg border px-3 py-3 text-sm ' +
        (isCurrent
          ? 'border-blue-300 bg-accent-fill dark:border-blue-900'
          : 'border-line bg-surface') +
        (isDragging ? ' z-10 shadow-lg' : '')
      }
    >
      <button
        type="button"
        aria-label={`Reorder ${track.title}`}
        className="-my-2 flex h-11 w-11 cursor-grab touch-none items-center justify-center text-neutral-400 hover:text-fg-body active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⠿</span>
      </button>

      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {position}
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={
            'block truncate ' +
            (isCurrent ? 'font-medium text-accent-strong' : 'font-medium')
          }
        >
          {track.title}
        </span>
        {track.subtitle && (
          <span className="block truncate text-xs minor-text-theme-colors">
            {track.subtitle}
          </span>
        )}
      </span>

      {track.durationSec != null && (
        <span className="shrink-0 text-xs tabular-nums minor-text-theme-colors">
          {formatDuration(track.durationSec)}
        </span>
      )}
    </li>
  );
}
