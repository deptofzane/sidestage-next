import type { ReactNode } from 'react';
import type { PlaylistTrack } from '../../player/PlaylistPlayer';

export interface Member {
  userId: string;
  email: string | null;
  name: string | null;
  role: 'owner' | 'member';
}

export interface Conversation {
  id: string;
  audioFileName: string | null;
  closed: boolean;
  archived: boolean;
  /** Who the song is originally by, for covers; null when it's the band's own. */
  originalArtist: string | null;
  bpm: number | null;
  key: string | null;
  /** When the song was added to the band — the Uploads history's sort key. */
  createdAt: string;
  updatedAt: string;
  /** Default audio version's duration in seconds; null when unknown. */
  songLength: number | null;
  /** Stored audio file name; null when the song has no audio yet. */
  audioStoredName: string | null;
  /** Stored audio MIME type; null when the song has no audio yet. */
  audioMimeType: string | null;
  /** Default audio version's id; null when the song has no audio yet. */
  audioVersionId: string | null;
  /** Whether the song has sheet music — i.e. whether Live has anything to show. */
  hasSheetMusic: boolean;
}

/**
 * A song's streaming URL, or null when it has no audio to play.
 *
 * Always names a version, even the default one. Without it the URL means
 * "whatever the default is now" — a moving target that the service worker
 * caches forever, so a song whose default changed would keep playing the old
 * take offline. Naming the version makes the URL immutable, which is the
 * assumption `CacheFirst` is built on.
 */
export function audioSrc(c: Conversation): string | null {
  if (!c.audioStoredName || !c.audioVersionId) return null;
  return (
    `/api/conversations/${c.id}/files/audio` +
    `?version=${c.audioVersionId}&name=${encodeURIComponent(c.audioStoredName)}`
  );
}

export interface Setlist {
  id: string;
  name: string;
  updatedAt: string;
  archived: boolean;
  songs: {
    id: string;
    conversationId: string | null;
    name: string;
    originalArtist: string | null;
    bpm: number | null;
    key: string | null;
    /** Duration in seconds; null for markers / unknown. */
    songLength: number | null;
    /**
     * Stored file name / MIME of the song's default audio version — null for
     * markers and songs with no audio yet, which is how callers tell what can
     * be played.
     */
    audioStoredName: string | null;
    audioMimeType: string | null;
    /** Default audio version's id — see `audioSrc` on why URLs name one. */
    audioVersionId: string | null;
    /** Every sheet version, with the stamp that moves when one is replaced. */
    sheetVersions: { id: string; updatedAt: string }[];
  }[];
}

/**
 * A setlist's songs as a player queue, in order. Markers (set breaks) and
 * songs with no audio drop out — a queue position isn't a setlist position.
 *
 * Takes just the name and songs rather than a whole `Setlist`, so callers
 * holding only those (the setlist page) don't have to invent the rest. A full
 * `Setlist` still satisfies it.
 */
export function setlistQueue(sl: {
  name: string;
  songs: Setlist['songs'];
}): PlaylistTrack[] {
  return sl.songs
    .filter((s) => s.conversationId && s.audioStoredName && s.audioVersionId)
    .map((s) => ({
      id: s.conversationId!,
      title: s.name,
      src:
        `/api/conversations/${s.conversationId}/files/audio` +
        `?version=${s.audioVersionId}&name=${encodeURIComponent(s.audioStoredName!)}`,
      fileName: s.audioStoredName!,
      mimeType: s.audioMimeType ?? undefined,
      href: `/notes/${s.conversationId}/practice`,
      originalArtist: s.originalArtist ?? undefined,
      bpm: s.bpm,
      songKey: s.key,
      subtitle: sl.name,
      durationSec: s.songLength ?? undefined,
    }));
}

/**
 * An album's tracks as a player queue, in order.
 *
 * The sibling of `setlistQueue`, and different in one way that matters: a
 * setlist always plays a song's current default, while an album track may pin
 * a specific version — so the src names whatever `resolveTrack` decided, which
 * is the pin when it still exists and the song's default when it doesn't.
 *
 * Unplayable tracks drop out, exactly as songs without audio drop out of a
 * setlist queue: a queue position isn't an album position. Tracks whose pin was
 * lost stay in — they play the default, and the album page is what says so.
 */
export function albumQueue(album: {
  name: string;
  tracks: {
    conversationId: string;
    name: string;
    audioVersionId: string | null;
    audioStoredName: string | null;
    audioMimeType: string | null;
    songLength: number | null;
    originalArtist: string | null;
    bpm: number | null;
    key: string | null;
  }[];
}): PlaylistTrack[] {
  return album.tracks
    .filter((t) => t.audioVersionId && t.audioStoredName)
    .map((t) => ({
      id: t.conversationId,
      title: t.name,
      src:
        `/api/conversations/${t.conversationId}/files/audio` +
        `?version=${t.audioVersionId}&name=${encodeURIComponent(t.audioStoredName!)}`,
      fileName: t.audioStoredName!,
      mimeType: t.audioMimeType ?? undefined,
      href: `/notes/${t.conversationId}/practice`,
      originalArtist: t.originalArtist ?? undefined,
      bpm: t.bpm,
      songKey: t.key,
      subtitle: album.name,
      durationSec: t.songLength ?? undefined,
    }));
}

export interface Venue {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  notes: string | null;
}

export interface Show {
  id: string;
  title: string;
  /** Drives the colour coding — see app/calendar/eventColors.ts. */
  eventType: string | null;
  date: string;
  /** Last day, inclusive; null when it ends the day it starts. */
  endDate: string | null;
  time: string | null;
  endTime: string | null;
  location: string | null;
  details: string | null;
  notes: string | null;
  setlistId: string | null;
  setlistName: string | null;
  venueId: string | null;
  venueName: string | null;
}

/** "N songs" — counts actual songs, ignoring markers (set breaks etc.). */
export function songCountLabel(
  songs: { conversationId: string | null }[],
): string {
  const n = songs.filter((s) => s.conversationId).length;
  return `${n} ${n === 1 ? 'song' : 'songs'}`;
}

/** ▸/▾ toggle for collapsing a band-page section. */
export function MinimizeToggle({
  minimized,
  onToggle,
  label,
  children,
}: {
  minimized: boolean;
  onToggle: () => void;
  label: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!minimized}
      aria-label={minimized ? `Expand ${label}` : `Minimize ${label}`}
      title={minimized ? `Expand ${label}` : `Minimize ${label}`}
      className="-mr-1 px-2 py-2 text-xl leading-none flex items-center gap-2"
    >
      <span aria-hidden="true" className="text-neutral-400 hover:text-fg-body">
        {minimized ? '▸' : '▾'}
      </span>
      {children}
    </button>
  );
}
