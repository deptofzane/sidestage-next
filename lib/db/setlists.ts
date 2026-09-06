import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { conversations, setlists, setlistSongs, songFiles } from './schema';

/**
 * Setlists — named, ordered lists of a band's songs. Access is scoped to
 * the owning band's membership (enforced by the routes). A conversation
 * appears at most once per setlist; order is stored as `position`.
 */

export type Setlist = typeof setlists.$inferSelect;

export interface SetlistSong {
  /** setlist_songs row id — stable identity, incl. for non-song markers. */
  id: string;
  /** Null for non-song items (set break / custom marker). */
  conversationId: string | null;
  /** Display name: the song's file name, or the marker's label. */
  name: string;
  /** Audio duration in whole seconds; null for markers / unknown. */
  songLength: number | null;
  /** Who the song is originally by; null for markers / unset. */
  originalArtist: string | null;
  /** Optional song tempo; null for markers / unset. */
  bpm: number | null;
  /** Optional song key; null for markers / unset. */
  key: string | null;
  /**
   * Stored file name / MIME of the song's default audio version — null for
   * markers and for songs with no audio yet, which is how callers tell what
   * can actually be played.
   */
  audioStoredName: string | null;
  audioMimeType: string | null;
  /** The default audio version's id — see `audioSrc` on why URLs name one. */
  audioVersionId: string | null;
  /**
   * Every sheet-music version, with the stamp that changes when a version's
   * file is replaced in place.
   *
   * All of them, not just the default: downloading a setlist caches every
   * sheet version, so telling a downloaded copy from the current one means
   * comparing the whole list. `updatedAt` is part of it because replacing a
   * version's file keeps its id — the bytes move, the identity doesn't.
   */
  sheetVersions: { id: string; updatedAt: string }[];
}

/** One item to persist: a song (conversationId) or a marker (label). */
export interface SetlistItemInput {
  conversationId: string | null;
  label: string | null;
}

function resolveName(
  audioFileName: string | null,
  label: string | null,
): string {
  return audioFileName ?? label ?? 'Untitled';
}

export interface SetlistWithSongs {
  id: string;
  name: string;
  updatedAt: string;
  archived: boolean;
  songs: SetlistSong[];
}

export interface SetlistDetail {
  id: string;
  bandId: string;
  name: string;
  songs: SetlistSong[];
}

/**
 * Create a setlist and its ordered items in one transaction. Accepts either
 * `items` (songs and/or markers) or the legacy `conversationIds` (songs).
 */
export async function createSetlist(input: {
  bandId: string;
  createdBy: string;
  name: string;
  conversationIds?: string[];
  items?: SetlistItemInput[];
}): Promise<Setlist> {
  const items: SetlistItemInput[] =
    input.items ??
    (input.conversationIds ?? []).map((conversationId) => ({
      conversationId,
      label: null,
    }));
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(setlists)
      .values({
        bandId: input.bandId,
        name: input.name,
        createdBy: input.createdBy,
      })
      .returning();
    if (items.length > 0) {
      await tx.insert(setlistSongs).values(
        items.map((it, position) => ({
          setlistId: row!.id,
          conversationId: it.conversationId,
          label: it.conversationId ? null : it.label,
          position,
        })),
      );
    }
    return row!;
  });
}

/** A single setlist with its ordered songs, or null if it doesn't exist. */
export async function getSetlist(
  setlistId: string,
): Promise<SetlistDetail | null> {
  const [row] = await db
    .select()
    .from(setlists)
    .where(eq(setlists.id, setlistId))
    .limit(1);
  if (!row) return null;

  const rows = await db
    .select({
      id: setlistSongs.id,
      conversationId: setlistSongs.conversationId,
      audioFileName: conversations.audioFileName,
      originalArtist: conversations.originalArtist,
      bpm: conversations.bpm,
      key: conversations.key,
      label: setlistSongs.label,
      songLength: songFiles.songLength,
      audioStoredName: songFiles.fileName,
      audioMimeType: songFiles.mimeType,
      audioVersionId: songFiles.id,
    })
    .from(setlistSongs)
    // Left join: marker items have no conversation.
    .leftJoin(conversations, eq(conversations.id, setlistSongs.conversationId))
    .leftJoin(
      songFiles,
      and(
        eq(songFiles.conversationId, setlistSongs.conversationId),
        eq(songFiles.kind, 'audio'),
        // Match only the default version, else a multi-version song would
        // appear once per version.
        eq(songFiles.isDefault, true),
      ),
    )
    .where(eq(setlistSongs.setlistId, setlistId))
    .orderBy(setlistSongs.position);

  // Sheet versions for these songs, in one query — see `listBandSetlists`.
  const convIds = [
    ...new Set(
      rows.map((r) => r.conversationId).filter((id): id is string => !!id),
    ),
  ];
  const sheetRows = convIds.length
    ? await db
        .select({
          conversationId: songFiles.conversationId,
          id: songFiles.id,
          updatedAt: songFiles.updatedAt,
        })
        .from(songFiles)
        .where(
          and(
            inArray(songFiles.conversationId, convIds),
            eq(songFiles.kind, 'sheet_music'),
          ),
        )
        .orderBy(asc(songFiles.createdAt))
    : [];
  const sheetsByConv = new Map<string, { id: string; updatedAt: string }[]>();
  for (const r of sheetRows) {
    const arr = sheetsByConv.get(r.conversationId) ?? [];
    arr.push({ id: r.id, updatedAt: r.updatedAt.toISOString() });
    sheetsByConv.set(r.conversationId, arr);
  }

  const songs: SetlistSong[] = rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    sheetVersions: r.conversationId
      ? (sheetsByConv.get(r.conversationId) ?? [])
      : [],
    name: resolveName(r.audioFileName, r.label),
    songLength: r.songLength,
    originalArtist: r.originalArtist,
    bpm: r.bpm,
    key: r.key,
    audioStoredName: r.audioStoredName,
    audioMimeType: r.audioMimeType,
    audioVersionId: r.audioVersionId,
  }));
  return { id: row.id, bandId: row.bandId, name: row.name, songs };
}

/**
 * Append a song to a setlist (idempotent — a repeat is a no-op via the
 * primary key). Position is one past the current max. Touches the setlist.
 */
export async function addSongToSetlist(
  setlistId: string,
  conversationId: string,
): Promise<void> {
  const rows = await db
    .select({ position: setlistSongs.position })
    .from(setlistSongs)
    .where(eq(setlistSongs.setlistId, setlistId));
  const nextPosition = rows.length
    ? Math.max(...rows.map((r) => r.position)) + 1
    : 0;
  await db
    .insert(setlistSongs)
    .values({ setlistId, conversationId, position: nextPosition })
    .onConflictDoNothing();
  await db
    .update(setlists)
    .set({ updatedAt: new Date() })
    .where(eq(setlists.id, setlistId));
}

/**
 * Set a setlist's items to exactly `items`, in that order — songs and/or
 * markers (set break / custom). The caller validates that song ids belong
 * to the band. Replaces the rows wholesale in one transaction.
 */
export async function setSetlistSongs(
  setlistId: string,
  items: SetlistItemInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(setlistSongs).where(eq(setlistSongs.setlistId, setlistId));
    if (items.length > 0) {
      await tx.insert(setlistSongs).values(
        items.map((it, position) => ({
          setlistId,
          conversationId: it.conversationId,
          // Markers carry a label; songs never do.
          label: it.conversationId ? null : it.label,
          position,
        })),
      );
    }
    await tx
      .update(setlists)
      .set({ updatedAt: new Date() })
      .where(eq(setlists.id, setlistId));
  });
}

/**
 * Just the id + name of a band's active (non-archived) setlists (newest
 * first) — for pickers (event association, add-to-setlist).
 */
export async function listBandSetlistNames(
  bandId: string,
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: setlists.id, name: setlists.name })
    .from(setlists)
    .where(and(eq(setlists.bandId, bandId), eq(setlists.archived, false)))
    .orderBy(desc(setlists.updatedAt));
}

/** Setlists in a band (newest first), each with its ordered songs. */
export async function listBandSetlists(
  bandId: string,
): Promise<SetlistWithSongs[]> {
  const lists = await db
    .select()
    .from(setlists)
    .where(eq(setlists.bandId, bandId))
    .orderBy(desc(setlists.updatedAt));
  if (lists.length === 0) return [];

  const ids = lists.map((l) => l.id);
  const rows = await db
    .select({
      setlistId: setlistSongs.setlistId,
      id: setlistSongs.id,
      conversationId: setlistSongs.conversationId,
      audioFileName: conversations.audioFileName,
      originalArtist: conversations.originalArtist,
      bpm: conversations.bpm,
      key: conversations.key,
      label: setlistSongs.label,
      songLength: songFiles.songLength,
      audioStoredName: songFiles.fileName,
      audioMimeType: songFiles.mimeType,
      audioVersionId: songFiles.id,
    })
    .from(setlistSongs)
    // Left join: marker items have no conversation.
    .leftJoin(conversations, eq(conversations.id, setlistSongs.conversationId))
    .leftJoin(
      songFiles,
      and(
        eq(songFiles.conversationId, setlistSongs.conversationId),
        eq(songFiles.kind, 'audio'),
        // Default version only — otherwise a multi-version song duplicates.
        eq(songFiles.isDefault, true),
      ),
    )
    .where(inArray(setlistSongs.setlistId, ids))
    .orderBy(setlistSongs.position);

  // Sheet versions for every song across these setlists, in one query. A join
  // above would have multiplied each song's row by its sheet count.
  const conversationIds = [
    ...new Set(
      rows.map((r) => r.conversationId).filter((id): id is string => !!id),
    ),
  ];
  const sheetRows = conversationIds.length
    ? await db
        .select({
          conversationId: songFiles.conversationId,
          id: songFiles.id,
          updatedAt: songFiles.updatedAt,
        })
        .from(songFiles)
        .where(
          and(
            inArray(songFiles.conversationId, conversationIds),
            eq(songFiles.kind, 'sheet_music'),
          ),
        )
        .orderBy(asc(songFiles.createdAt))
    : [];
  const sheetsByConv = new Map<string, { id: string; updatedAt: string }[]>();
  for (const r of sheetRows) {
    const arr = sheetsByConv.get(r.conversationId) ?? [];
    arr.push({ id: r.id, updatedAt: r.updatedAt.toISOString() });
    sheetsByConv.set(r.conversationId, arr);
  }

  const byList = new Map<string, SetlistSong[]>();
  for (const s of rows) {
    const arr = byList.get(s.setlistId) ?? [];
    arr.push({
      id: s.id,
      conversationId: s.conversationId,
      name: resolveName(s.audioFileName, s.label),
      songLength: s.songLength,
      originalArtist: s.originalArtist,
      bpm: s.bpm,
      key: s.key,
      audioStoredName: s.audioStoredName,
      audioMimeType: s.audioMimeType,
      audioVersionId: s.audioVersionId,
      sheetVersions: s.conversationId
        ? (sheetsByConv.get(s.conversationId) ?? [])
        : [],
    });
    byList.set(s.setlistId, arr);
  }

  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    updatedAt: l.updatedAt.toISOString(),
    archived: l.archived,
    songs: byList.get(l.id) ?? [],
  }));
}

/**
 * Permanently delete a setlist. Its songs cascade; any event's association to
 * it is cleared (the events.setlist_id FK is ON DELETE SET NULL).
 */
export async function deleteSetlist(setlistId: string): Promise<void> {
  await db.delete(setlists).where(eq(setlists.id, setlistId));
}

/** Archive or unarchive a setlist (reversible). Bumps updatedAt. */
/** Rename a setlist. The caller has already checked band membership. */
export async function renameSetlist(
  setlistId: string,
  name: string,
): Promise<void> {
  await db
    .update(setlists)
    .set({ name, updatedAt: new Date() })
    .where(eq(setlists.id, setlistId));
}

export async function setSetlistArchived(
  setlistId: string,
  archived: boolean,
): Promise<void> {
  await db
    .update(setlists)
    .set({ archived, updatedAt: new Date() })
    .where(eq(setlists.id, setlistId));
}

export interface PracticeSong {
  /** Null for a marker step (set break / custom) — not playable. */
  conversationId: string | null;
  title: string;
  mimeType: string;
  /** Who the song is originally by; null for markers and for the band's own. */
  originalArtist: string | null;
  /** Tempo / musical key; null for markers and for songs that haven't set them. */
  bpm: number | null;
  songKey: string | null;
  sheetMusic: { fileName: string; mimeType: string; updatedAt: string } | null;
  /**
   * Every audio version, so Practice can offer a switcher. One entry (or
   * none) means there's nothing to switch between.
   */
  audioVersions: {
    id: string;
    fileName: string;
    mimeType: string;
    label: string | null;
    isDefault: boolean;
  }[];
}

/**
 * A setlist's items, in order, enriched for the Practice view. Songs carry
 * their audio MIME type and sheet-music metadata; markers (set breaks /
 * custom) come through as non-playable steps (conversationId null). Two
 * queries — the ordered items, then a batched lookup of the songs' files.
 */
export async function getSetlistPracticeSongs(
  setlistId: string,
): Promise<PracticeSong[]> {
  const rows = await db
    .select({
      conversationId: setlistSongs.conversationId,
      audioFileName: conversations.audioFileName,
      originalArtist: conversations.originalArtist,
      bpm: conversations.bpm,
      key: conversations.key,
      label: setlistSongs.label,
    })
    .from(setlistSongs)
    .leftJoin(conversations, eq(conversations.id, setlistSongs.conversationId))
    .where(eq(setlistSongs.setlistId, setlistId))
    .orderBy(asc(setlistSongs.position));
  if (rows.length === 0) return [];

  const ids = rows
    .map((r) => r.conversationId)
    .filter((id): id is string => id !== null);
  const files = ids.length
    ? await db
        .select({
          id: songFiles.id,
          conversationId: songFiles.conversationId,
          kind: songFiles.kind,
          isDefault: songFiles.isDefault,
          fileName: songFiles.fileName,
          mimeType: songFiles.mimeType,
          label: songFiles.label,
          updatedAt: songFiles.updatedAt,
        })
        .from(songFiles)
        .where(inArray(songFiles.conversationId, ids))
    : [];

  const audioByConv = new Map<string, (typeof files)[number]>();
  const sheetByConv = new Map<string, (typeof files)[number]>();
  // Every audio version, not just the default — the switcher needs the rest.
  const versionsByConv = new Map<string, (typeof files)[number][]>();
  for (const f of files) {
    // A song can have several audio versions; use the default one.
    if (f.kind === 'audio') {
      if (f.isDefault) audioByConv.set(f.conversationId, f);
      versionsByConv.set(f.conversationId, [
        ...(versionsByConv.get(f.conversationId) ?? []),
        f,
      ]);
    } else if (f.kind === 'sheet_music') sheetByConv.set(f.conversationId, f);
  }

  return rows.map((r) => {
    if (!r.conversationId) {
      // A marker (set break / custom) — a step with no audio.
      return {
        conversationId: null,
        title: r.label ?? 'Set break',
        mimeType: '',
        originalArtist: null,
        bpm: null,
        songKey: null,
        sheetMusic: null,
        audioVersions: [],
      };
    }
    const audio = audioByConv.get(r.conversationId);
    const sheet = sheetByConv.get(r.conversationId);
    return {
      conversationId: r.conversationId,
      title: r.audioFileName ?? audio?.fileName ?? 'Untitled audio',
      mimeType: audio?.mimeType ?? 'audio/mpeg',
      originalArtist: r.originalArtist,
      bpm: r.bpm,
      songKey: r.key,
      audioVersions: (versionsByConv.get(r.conversationId) ?? []).map((v) => ({
        id: v.id,
        fileName: v.fileName,
        mimeType: v.mimeType,
        label: v.label,
        isDefault: v.isDefault,
      })),
      sheetMusic: sheet
        ? {
            fileName: sheet.fileName,
            mimeType: sheet.mimeType,
            updatedAt: sheet.updatedAt.toISOString(),
          }
        : null,
    };
  });
}

/**
 * Build a single-song Practice/Live item for one conversation — used by the
 * per-song Practice and Live routes. Uses the default audio version and the
 * song's sheet music, if any. Returns null if the conversation is gone.
 */
export async function getConversationPracticeSong(
  conversationId: string,
): Promise<PracticeSong | null> {
  const [conv] = await db
    .select({
      audioFileName: conversations.audioFileName,
      originalArtist: conversations.originalArtist,
      bpm: conversations.bpm,
      key: conversations.key,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return null;

  const files = await db
    .select({
      id: songFiles.id,
      kind: songFiles.kind,
      isDefault: songFiles.isDefault,
      fileName: songFiles.fileName,
      label: songFiles.label,
      mimeType: songFiles.mimeType,
      updatedAt: songFiles.updatedAt,
    })
    .from(songFiles)
    .where(eq(songFiles.conversationId, conversationId));

  const audio =
    files.find((f) => f.kind === 'audio' && f.isDefault) ??
    files.find((f) => f.kind === 'audio');
  const sheet = files.find((f) => f.kind === 'sheet_music');

  return {
    conversationId,
    title: conv.audioFileName ?? audio?.fileName ?? 'Untitled audio',
    mimeType: audio?.mimeType ?? 'audio/mpeg',
    originalArtist: conv.originalArtist,
    bpm: conv.bpm,
    songKey: conv.key,
    audioVersions: files
      .filter((f) => f.kind === 'audio')
      .map((v) => ({
        id: v.id,
        fileName: v.fileName,
        mimeType: v.mimeType,
        label: v.label,
        isDefault: v.isDefault,
      })),
    sheetMusic: sheet
      ? {
          fileName: sheet.fileName,
          mimeType: sheet.mimeType,
          updatedAt: sheet.updatedAt.toISOString(),
        }
      : null,
  };
}
