'use client';

import { formatDateLong } from '@/lib/format';
import type { BandUpload } from '@/lib/db/song-files';
import type { PlaylistTrack } from '../../../player/PlaylistPlayer';

/**
 * Upload-day helpers shared by the Uploads tab and the per-day tracks page.
 *
 * Days are the viewer's *local* calendar days: a song added at 10pm belongs to
 * that evening, not to the next UTC date. The day key doubles as the URL
 * segment for the tracks page, so both sides must derive it the same way.
 */

/** Local calendar day ("2026-07-30") for an ISO timestamp. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today's key, for tagging an upload with the day the uploader is having. */
export function todayKey(): string {
  return dayKey(new Date().toISOString());
}

/** "Today" / "Yesterday" for the two most recent days, else the full date. */
export function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  if (key === today) return 'Today';
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === yesterday) return 'Yesterday';
  return formatDateLong(key);
}

/** "2:31 PM" — the clock time a song was added. */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Songs bucketed by the day they were added — newest day first, and within a
 * day in the order they were added.
 */
export function groupByDay(uploads: BandUpload[]): [string, BandUpload[]][] {
  const keys = [...new Set(uploads.map((u) => dayKey(u.createdAt)))].sort(
    (a, b) => b.localeCompare(a),
  );
  return keys.map((key) => [key, uploadsForDay(uploads, key)]);
}

/**
 * The uploads made on `key`, in the order they arrived. Internal to the
 * grouping now — the per-day page asks the server for its day rather than
 * filtering a list it would have had to hold all of.
 */
function uploadsForDay(uploads: BandUpload[], key: string): BandUpload[] {
  return uploads
    .filter((u) => dayKey(u.createdAt) === key)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * An uploaded file as a queue entry.
 *
 * `id` stays the *conversation* id, not the file's: it's what the player's
 * row actions resolve (View song, Edit, Add to setlist). Two takes of one song
 * therefore share an id, which is already true of a song queued twice — the
 * queue identifies rows by position, not id.
 *
 * The song names the track and the file names the line beneath it, so two
 * versions of the same song are still tellable apart mid-set.
 */
export function uploadTrack(u: BandUpload): PlaylistTrack {
  return {
    id: u.conversationId,
    title: u.title,
    src:
      `/api/conversations/${u.conversationId}/files/audio` +
      `?version=${u.fileId}&name=${encodeURIComponent(u.fileName)}`,
    fileName: u.fileName,
    mimeType: u.mimeType,
    href: `/notes/${u.conversationId}/practice?from=audio`,
    originalArtist: u.originalArtist ?? undefined,
    bpm: u.bpm,
    songKey: u.key,
    subtitle: u.label || u.fileName,
    durationSec: u.songLength ?? undefined,
  };
}

/** Every upload made on `key`, as a playable queue in upload order. */
export function uploadsQueue(
  uploads: BandUpload[],
  key: string,
): PlaylistTrack[] {
  return uploadsForDay(uploads, key).map(uploadTrack);
}
