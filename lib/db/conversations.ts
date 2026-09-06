import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db, type DbExecutor } from './index';
import { bandMembers, conversations, songFiles } from './schema';
import { recordActivity } from './activity';
import { deleteObjects, storageKeysForConversation } from './song-files';

/**
 * Conversation lifecycle + membership (Postgres).
 *
 * A conversation is one row per (band, Drive audio file). "Registering"
 * an audio file under a band is just find-or-create. Authorization flows
 * through the owning band: you can touch a conversation iff you're a
 * member of its band (`getConversationMembership` joins through band_id).
 */

export type Conversation = typeof conversations.$inferSelect;
export type BandRole = (typeof bandMembers.role.enumValues)[number];

class ConversationAccessError extends Error {
  constructor(message = 'Not a member of this conversation’s band') {
    super(message);
    this.name = 'ConversationAccessError';
  }
}

/** Find or create the conversation for a (band, audio file) pair. */
export async function findOrCreateConversation(
  bandId: string,
  driveAudioFileId: string,
  audioFileName: string | null,
  exec: DbExecutor = db,
): Promise<Conversation> {
  await exec
    .insert(conversations)
    .values({ bandId, driveAudioFileId, audioFileName })
    .onConflictDoNothing({
      target: [conversations.bandId, conversations.driveAudioFileId],
    });

  const [row] = await exec
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.bandId, bandId),
        eq(conversations.driveAudioFileId, driveAudioFileId),
      ),
    )
    .limit(1);
  return row!;
}

export async function getConversationById(
  conversationId: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

export interface ConversationMembership {
  conversation: Conversation;
  role: BandRole;
}

/**
 * Resolve the requesting user's access to a conversation by joining
 * through the owning band's membership. Null if the conversation doesn't
 * exist or the user isn't in its band.
 */
export async function getConversationMembership(
  userId: string,
  conversationId: string,
): Promise<ConversationMembership | null> {
  const [row] = await db
    .select({ conversation: conversations, role: bandMembers.role })
    .from(conversations)
    .innerJoin(
      bandMembers,
      and(
        eq(bandMembers.bandId, conversations.bandId),
        eq(bandMembers.userId, userId),
      ),
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

/** Authorization primitive — throws if the user can't access it. */
export async function assertConversationMember(
  userId: string,
  conversationId: string,
): Promise<ConversationMembership> {
  const m = await getConversationMembership(userId, conversationId);
  if (!m) throw new ConversationAccessError();
  return m;
}

/**
 * A band's conversation plus its default audio version's metadata. The audio
 * fields are null for songs created from just a name (no audio yet), which is
 * what callers use to tell playable songs from the rest.
 */
export interface BandConversation extends Conversation {
  /** Duration in whole seconds; null when unknown or there's no audio. */
  songLength: number | null;
  /** Stored file name of the default audio version; null with no audio. */
  audioStoredName: string | null;
  /** MIME type of the default audio version; null with no audio. */
  audioMimeType: string | null;
  /**
   * The default audio version's id, so callers can address it explicitly.
   * URLs that name a version are immutable — the bytes behind them never
   * change — which is what lets the service worker cache audio forever.
   */
  audioVersionId: string | null;
  /**
   * Whether the song has any sheet music at all — what callers use to tell
   * whether the sheet-reading views (Live, Practice) have anything to show.
   */
  hasSheetMusic: boolean;
}

export async function listBandConversations(
  bandId: string,
): Promise<BandConversation[]> {
  return (
    db
      .select({
        ...getTableColumns(conversations),
        songLength: songFiles.songLength,
        audioStoredName: songFiles.fileName,
        audioMimeType: songFiles.mimeType,
        audioVersionId: songFiles.id,
        // A subquery rather than another join: a song can have several sheet
        // versions, and joining them would duplicate its row.
        hasSheetMusic: sql<boolean>`exists (
        select 1 from ${songFiles} sheets
        where sheets.conversation_id = ${conversations.id}
          and sheets.kind = 'sheet_music'
      )`,
      })
      .from(conversations)
      // Left join: songs without audio still belong in the list. Matched to the
      // default version only, else a multi-version song would appear once per
      // version.
      .leftJoin(
        songFiles,
        and(
          eq(songFiles.conversationId, conversations.id),
          eq(songFiles.kind, 'audio'),
          eq(songFiles.isDefault, true),
        ),
      )
      .where(eq(conversations.bandId, bandId))
      .orderBy(desc(conversations.updatedAt))
  );
}

/**
 * Bump a conversation's updated_at (its "last activity" sort key). Uses the
 * DB clock (`now()`) so it stays comparable to `conversation_reads.lastSeenAt`
 * and note/activity timestamps — no app-vs-Postgres clock skew in read state.
 */
export async function touchConversation(
  exec: DbExecutor,
  conversationId: string,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(conversations.id, conversationId));
}

/**
 * Open/close a conversation. Idempotent; only logs activity when the
 * state actually flips.
 */
export async function setConversationClosed(
  conversationId: string,
  actorId: string,
  closed: boolean,
): Promise<{ closed: boolean }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ closed: conversations.closed })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!current) throw new ConversationAccessError('Conversation not found');
    if (current.closed === closed) return { closed };

    await tx
      .update(conversations)
      .set({ closed, updatedAt: sql`now()` })
      .where(eq(conversations.id, conversationId));
    await recordActivity(
      tx,
      conversationId,
      actorId,
      closed ? 'closed' : 'reopened',
    );
    return { closed };
  });
}

export class ConversationConflictError extends Error {
  constructor(message = 'That band already has this song.') {
    super(message);
    this.name = 'ConversationConflictError';
  }
}

/** Archive or unarchive a song (moves it to a separate band list). */
export async function setConversationArchived(
  conversationId: string,
  archived: boolean,
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set({ archived })
    .where(eq(conversations.id, conversationId))
    .returning();
  return row!;
}

/** Rename a song (the conversation's display name). */
export async function renameConversation(
  conversationId: string,
  name: string,
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set({ audioFileName: name })
    .where(eq(conversations.id, conversationId))
    .returning();
  return row!;
}

/**
 * Update a song's optional metadata (original artist / tempo / key). Only the
 * provided fields are changed; pass `null` to clear one. All are optional and
 * start blank.
 */
export async function setConversationMeta(
  conversationId: string,
  fields: {
    originalArtist?: string | null;
    bpm?: number | null;
    key?: string | null;
  },
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set(fields)
    .where(eq(conversations.id, conversationId))
    .returning();
  return row!;
}

/**
 * Move a song to a different band. Throws ConversationConflictError if
 * the target band already has a conversation for the same audio file
 * (the (band, drive_audio_file_id) unique constraint).
 */
export async function moveConversation(
  conversationId: string,
  bandId: string,
): Promise<Conversation> {
  try {
    const [row] = await db
      .update(conversations)
      .set({ bandId })
      .where(eq(conversations.id, conversationId))
      .returning();
    return row!;
  } catch (err) {
    // Postgres unique_violation. drizzle wraps the driver error, so the
    // code may live on the error or its `.cause`.
    if (pgErrorCode(err) === '23505') throw new ConversationConflictError();
    throw err;
  }
}

/** Extract a Postgres error code from a (possibly drizzle-wrapped) error. */
function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (e.cause && typeof e.cause === 'object') {
    const code = (e.cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Delete a song and everything it owns (notes, mentions, activity, read
 * state, file rows) via FK cascade. FK cascade can't reach object storage,
 * so we collect the object keys first and best-effort delete them after.
 */
export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  const keys = await storageKeysForConversation(conversationId);
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await deleteObjects(keys);
}
