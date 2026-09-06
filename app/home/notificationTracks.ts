import {
  audioSrc,
  type Conversation,
} from '@/app/bands/[bandId]/bandDetailShared';
import type { PlaylistTrack } from '../player/PlaylistPlayer';

/** The bits of a notification this module needs to find what to play. */
export interface PlayableNotification {
  kind: string;
  subjectId: string | null;
  subjectLabel: string | null;
  bandName: string | null;
  createdAt: string;
  /** Rollups only: the day they cover. */
  day?: string | null;
}

/** Whether this notification announces something the player can load. */
export function isPlayableNotification(n: PlayableNotification): boolean {
  return isUploadNotification(n) || isSetlistNotification(n);
}

/** An upload: one named song, or the day's rollup. */
export function isUploadNotification(n: PlayableNotification): boolean {
  return n.kind === 'audio-added';
}

/**
 * A new setlist. Unlike a rollup this names its subject, so it resolves to
 * exactly that setlist — no guessing from timestamps.
 */
export function isSetlistNotification(n: PlayableNotification): boolean {
  return n.kind === 'setlist-created' && n.subjectId !== null;
}

/**
 * The songs a single named upload notification is about.
 *
 * These name their conversation, so they resolve exactly. Rollups don't —
 * they cover a day, and their contents include new versions of existing
 * songs, so they resolve from the band's uploads instead (`uploadsQueue`).
 *
 * Songs without audio are dropped: a queue entry that can't play is worse
 * than a shorter queue, and a notification whose song has since been deleted
 * correctly resolves to nothing.
 */
export function tracksForNotification(
  n: PlayableNotification,
  conversations: Conversation[],
): PlaylistTrack[] {
  if (!n.subjectId) return [];
  const songs = conversations.filter(
    (c) => c.id === n.subjectId && audioSrc(c) !== null,
  );

  return songs.map((c) => ({
    id: c.id,
    title: c.audioFileName ?? 'Untitled audio',
    src: audioSrc(c)!,
    fileName: c.audioStoredName ?? undefined,
    mimeType: c.audioMimeType ?? undefined,
    href: `/notes/${c.id}/practice?from=audio`,
    originalArtist: c.originalArtist ?? undefined,
    bpm: c.bpm,
    songKey: c.key,
    subtitle: n.bandName ?? undefined,
    durationSec: c.songLength ?? undefined,
  }));
}
