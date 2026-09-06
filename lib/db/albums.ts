import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './index';
import { albums, albumTracks, conversations, songFiles } from './schema';

/**
 * Albums — named, ordered collections of a band's songs, where a track may pin
 * one specific audio version instead of following the song's default.
 *
 * Access is scoped to the owning band's membership (enforced by the routes),
 * exactly as setlists are. Order is `position`; unlike a setlist, a song may
 * appear on one album more than once.
 *
 * The interesting part is what happens when a pinned version is deleted. That
 * hard-deletes the row and its bytes (`deleteAudioVersion`), so the album keeps
 * a snapshot of the version's name taken when it was pinned — see
 * `album_tracks` in schema.ts. Playback then falls back to the song's current
 * default and the track is flagged, rather than going silently dead while the
 * song itself plays perfectly well elsewhere.
 */

export type Album = typeof albums.$inferSelect;

/** How a track resolved: which version will actually play, and why. */
export type TrackPinState =
  /** No version pinned — plays the song's current default. */
  | 'default'
  /** Pinned, and that version still exists. */
  | 'pinned'
  /**
   * Pinned, but the version was deleted. Plays the song's default instead;
   * `pinned*` fields describe what was lost so the UI can say so.
   */
  | 'lost'
  /** Nothing to play: no pin (or a lost one) and the song has no audio. */
  | 'unplayable';

export interface AlbumTrack {
  /** album_tracks row id — the track's identity, since songs may repeat. */
  id: string;
  conversationId: string;
  /** The song's display name. */
  name: string;
  position: number;
  state: TrackPinState;
  /**
   * The version that will play, resolved. Null only when `state` is
   * `unplayable`. These are what a queue is built from.
   */
  audioVersionId: string | null;
  audioStoredName: string | null;
  audioMimeType: string | null;
  songLength: number | null;
  /** What was pinned, from the snapshot. Non-null whenever a pin was made. */
  pinnedFileName: string | null;
  pinnedLabel: string | null;
  /** Song metadata, for the same reasons setlists carry it. */
  originalArtist: string | null;
  bpm: number | null;
  key: string | null;
}

export interface AlbumWithTracks {
  id: string;
  bandId: string;
  name: string;
  archived: boolean;
  updatedAt: string;
  tracks: AlbumTrack[];
}

/** One track to persist. `audioVersionId` null means "follow the default". */
export interface AlbumTrackInput {
  conversationId: string;
  audioVersionId: string | null;
}

/**
 * Resolve one row's playback state.
 *
 * Split out and exported so the rules can be tested directly — the four states
 * are the whole feature, and driving them through a database each time makes
 * for slow, indirect tests.
 */
export function resolveTrack(row: {
  audioVersionId: string | null;
  pinnedFileName: string | null;
  pinnedVersion: {
    id: string;
    fileName: string;
    mimeType: string;
    songLength: number | null;
  } | null;
  defaultVersion: {
    id: string;
    fileName: string;
    mimeType: string;
    songLength: number | null;
  } | null;
}): {
  state: TrackPinState;
  audioVersionId: string | null;
  audioStoredName: string | null;
  audioMimeType: string | null;
  songLength: number | null;
} {
  // Not named `use`: that's a React hook name, and the lint rule that guards
  // hook usage matches on the identifier wherever it appears.
  const playFrom = (
    state: TrackPinState,
    v: {
      id: string;
      fileName: string;
      mimeType: string;
      songLength: number | null;
    },
  ) => ({
    state,
    audioVersionId: v.id,
    audioStoredName: v.fileName,
    audioMimeType: v.mimeType,
    songLength: v.songLength,
  });
  const nothing = {
    state: 'unplayable' as const,
    audioVersionId: null,
    audioStoredName: null,
    audioMimeType: null,
    songLength: null,
  };

  // Pinned and still there.
  if (row.pinnedVersion) return playFrom('pinned', row.pinnedVersion);
  // Pinned once, gone now: the FK nulled the id, the snapshot survives.
  const wasPinned = row.audioVersionId === null && row.pinnedFileName !== null;
  if (row.defaultVersion) {
    return playFrom(wasPinned ? 'lost' : 'default', row.defaultVersion);
  }
  return nothing;
}

/** Albums for a band, newest first, without their tracks. */
export async function listAlbums(
  bandId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Album[]> {
  return db
    .select()
    .from(albums)
    .where(
      includeArchived
        ? eq(albums.bandId, bandId)
        : and(eq(albums.bandId, bandId), eq(albums.archived, false)),
    )
    .orderBy(asc(albums.name));
}

/**
 * Track rows for one or more albums, resolved and grouped by album id.
 *
 * One query whatever the number of albums: the Songs tab's album view needs
 * every album's tracks at once, and doing that a request at a time would be a
 * query per album for a page that already knows it wants all of them.
 *
 * Each row joins to its pinned version (which may be gone) and to the song's
 * current default; `resolveTrack` turns the pair into a state. The default join
 * relies on the partial unique index guaranteeing at most one `is_default`
 * audio row per conversation.
 */
async function tracksByAlbum(
  albumIds: string[],
): Promise<Map<string, AlbumTrack[]>> {
  const out = new Map<string, AlbumTrack[]>();
  if (albumIds.length === 0) return out;

  const pinned = db
    .select()
    .from(songFiles)
    .where(eq(songFiles.kind, 'audio'))
    .as('pinned');
  const def = db
    .select()
    .from(songFiles)
    .where(and(eq(songFiles.kind, 'audio'), eq(songFiles.isDefault, true)))
    .as('def');

  const rows = await db
    .select({
      albumId: albumTracks.albumId,
      id: albumTracks.id,
      conversationId: albumTracks.conversationId,
      position: albumTracks.position,
      audioVersionId: albumTracks.audioVersionId,
      pinnedFileName: albumTracks.pinnedFileName,
      pinnedLabel: albumTracks.pinnedLabel,
      name: conversations.audioFileName,
      originalArtist: conversations.originalArtist,
      bpm: conversations.bpm,
      key: conversations.key,
      pinnedId: pinned.id,
      pinnedName: pinned.fileName,
      pinnedMime: pinned.mimeType,
      pinnedSeconds: pinned.songLength,
      defaultId: def.id,
      defaultName: def.fileName,
      defaultMime: def.mimeType,
      defaultSeconds: def.songLength,
    })
    .from(albumTracks)
    .innerJoin(conversations, eq(conversations.id, albumTracks.conversationId))
    .leftJoin(pinned, eq(pinned.id, albumTracks.audioVersionId))
    .leftJoin(def, eq(def.conversationId, albumTracks.conversationId))
    .where(inArray(albumTracks.albumId, albumIds))
    .orderBy(asc(albumTracks.position));

  for (const r of rows) {
    const resolved = resolveTrack({
      audioVersionId: r.audioVersionId,
      pinnedFileName: r.pinnedFileName,
      pinnedVersion: r.pinnedId
        ? {
            id: r.pinnedId,
            fileName: r.pinnedName!,
            mimeType: r.pinnedMime!,
            songLength: r.pinnedSeconds,
          }
        : null,
      defaultVersion: r.defaultId
        ? {
            id: r.defaultId,
            fileName: r.defaultName!,
            mimeType: r.defaultMime!,
            songLength: r.defaultSeconds,
          }
        : null,
    });
    const track: AlbumTrack = {
      id: r.id,
      conversationId: r.conversationId,
      name: r.name ?? 'Untitled',
      position: r.position,
      pinnedFileName: r.pinnedFileName,
      pinnedLabel: r.pinnedLabel,
      originalArtist: r.originalArtist,
      bpm: r.bpm,
      key: r.key,
      ...resolved,
    };
    const list = out.get(r.albumId);
    if (list) list.push(track);
    else out.set(r.albumId, [track]);
  }
  return out;
}

/** One album with its tracks resolved, or null. */
export async function getAlbum(
  albumId: string,
): Promise<AlbumWithTracks | null> {
  const [album] = await db
    .select()
    .from(albums)
    .where(eq(albums.id, albumId))
    .limit(1);
  if (!album) return null;
  const tracks = (await tracksByAlbum([album.id])).get(album.id) ?? [];
  return {
    id: album.id,
    bandId: album.bandId,
    name: album.name,
    archived: album.archived,
    updatedAt: album.updatedAt.toISOString(),
    tracks,
  };
}

/** A band's albums, each with its tracks resolved — the album view's payload. */
export async function listAlbumsWithTracks(
  bandId: string,
): Promise<AlbumWithTracks[]> {
  const list = await listAlbums(bandId);
  const byAlbum = await tracksByAlbum(list.map((a) => a.id));
  return list.map((a) => ({
    id: a.id,
    bandId: a.bandId,
    name: a.name,
    archived: a.archived,
    updatedAt: a.updatedAt.toISOString(),
    tracks: byAlbum.get(a.id) ?? [],
  }));
}

/**
 * Which of `conversationIds` sit on at least one album of this band.
 *
 * Powers the Songs tab's "Unassociated" group. Returned as a Set of the ids
 * that *are* filed, so the caller can invert it against whatever list it's
 * already holding rather than this needing to know about it.
 */
export async function songsOnAnyAlbum(
  bandId: string,
  conversationIds: string[],
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ conversationId: albumTracks.conversationId })
    .from(albumTracks)
    .innerJoin(albums, eq(albums.id, albumTracks.albumId))
    .where(
      and(
        eq(albums.bandId, bandId),
        inArray(albumTracks.conversationId, conversationIds),
      ),
    );
  return new Set(rows.map((r) => r.conversationId));
}

/**
 * Reject a pin that names a version belonging to a different song.
 *
 * The foreign key only guarantees the version exists — nothing stops one song's
 * track pointing at another song's audio, which would play the wrong recording.
 * Returns the rows that are valid to pin, keyed by version id.
 */
async function validPins(
  items: AlbumTrackInput[],
): Promise<
  Map<
    string,
    { fileName: string; label: string | null; songLength: number | null }
  >
> {
  const wanted = items
    .filter((i) => i.audioVersionId)
    .map((i) => i.audioVersionId!);
  if (wanted.length === 0) return new Map();

  const rows = await db
    .select({
      id: songFiles.id,
      conversationId: songFiles.conversationId,
      fileName: songFiles.fileName,
      label: songFiles.label,
      songLength: songFiles.songLength,
    })
    .from(songFiles)
    .where(and(inArray(songFiles.id, wanted), eq(songFiles.kind, 'audio')));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<
    string,
    { fileName: string; label: string | null; songLength: number | null }
  >();
  for (const item of items) {
    if (!item.audioVersionId) continue;
    const row = byId.get(item.audioVersionId);
    // Silently dropping a mismatch would pin nothing and look like a save bug,
    // so this is loud: the caller (a route) turns it into a 400.
    if (!row || row.conversationId !== item.conversationId) {
      throw new AlbumPinError(item.audioVersionId, item.conversationId);
    }
    out.set(item.audioVersionId, {
      fileName: row.fileName,
      label: row.label,
      songLength: row.songLength,
    });
  }
  return out;
}

/** Thrown when a track pins a version that isn't that song's. */
export class AlbumPinError extends Error {
  constructor(
    readonly versionId: string,
    readonly conversationId: string,
  ) {
    super(
      `Audio version ${versionId} does not belong to song ${conversationId}`,
    );
    this.name = 'AlbumPinError';
  }
}

export async function createAlbum(
  bandId: string,
  createdBy: string,
  name: string,
  items: AlbumTrackInput[] = [],
): Promise<string> {
  const pins = await validPins(items);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(albums)
      .values({ bandId, name, createdBy })
      .returning({ id: albums.id });
    const albumId = row!.id;
    await insertTracks(tx, albumId, items, pins);
    return albumId;
  });
}

/**
 * Replace an album's tracks wholesale, the way setlists are saved.
 *
 * Simpler than diffing, and correct for reordering — positions are rewritten
 * from the array's order either way. The snapshot is re-taken here, so editing
 * an album refreshes the pinned name if the version was renamed.
 */
export async function replaceAlbumTracks(
  albumId: string,
  items: AlbumTrackInput[],
): Promise<void> {
  const pins = await validPins(items);
  await db.transaction(async (tx) => {
    await tx.delete(albumTracks).where(eq(albumTracks.albumId, albumId));
    await insertTracks(tx, albumId, items, pins);
    await tx
      .update(albums)
      .set({ updatedAt: sql`now()` })
      .where(eq(albums.id, albumId));
  });
}

async function insertTracks(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  albumId: string,
  items: AlbumTrackInput[],
  pins: Map<
    string,
    { fileName: string; label: string | null; songLength: number | null }
  >,
): Promise<void> {
  if (items.length === 0) return;
  await tx.insert(albumTracks).values(
    items.map((item, position) => {
      const pin = item.audioVersionId ? pins.get(item.audioVersionId) : null;
      return {
        albumId,
        conversationId: item.conversationId,
        position,
        audioVersionId: item.audioVersionId,
        // Written together with the id: this is the copy that outlives it.
        pinnedFileName: pin?.fileName ?? null,
        pinnedLabel: pin?.label ?? null,
        pinnedLength: pin?.songLength ?? null,
      };
    }),
  );
}

export async function renameAlbum(
  albumId: string,
  name: string,
): Promise<void> {
  await db
    .update(albums)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(albums.id, albumId));
}

export async function setAlbumArchived(
  albumId: string,
  archived: boolean,
): Promise<void> {
  await db
    .update(albums)
    .set({ archived, updatedAt: sql`now()` })
    .where(eq(albums.id, albumId));
}

export async function deleteAlbum(albumId: string): Promise<void> {
  await db.delete(albums).where(eq(albums.id, albumId));
}

/**
 * Drop a lost pin, so the track follows the song's default from now on.
 *
 * The "Use the current default" action: without it the only way to clear a
 * flagged track is the full editor, and flags would pile up unresolved.
 */
export async function clearTrackPin(trackId: string): Promise<void> {
  await db
    .update(albumTracks)
    .set({
      audioVersionId: null,
      pinnedFileName: null,
      pinnedLabel: null,
      pinnedLength: null,
    })
    .where(eq(albumTracks.id, trackId));
}
