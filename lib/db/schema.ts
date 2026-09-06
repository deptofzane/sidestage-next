import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  bigserial,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ── Enums ────────────────────────────────────────────────────────────
export const bandRole = pgEnum('band_role', ['owner', 'member']);
export const activityKind = pgEnum('activity_kind', [
  'note-created',
  'note-updated',
  'note-deleted',
  'reply-created',
  'closed',
  'reopened',
  'resolved',
  'unresolved',
]);

// ── Users ────────────────────────────────────────────────────────────
// A user has an email/password credential (password_hash set) and/or one
// or more linked OAuth accounts (see `accounts`). `email` is the credential
// login key — unique, always stored lowercase. Linked OAuth identities
// live in `accounts`, not here, so a user can connect a Google account
// whose email differs from their login email.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  name: text('name'),
  // Set when the account is deleted. The row survives as a tombstone because
  // song comments, chat, and activity all reference it and are meant to
  // outlive the account (see lib/db/account-deletion.ts); everything personal
  // — email, password, name, linked providers — is stripped at that point.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── Linked OAuth accounts ────────────────────────────────────────────
// One row per (provider, external account) linked to a user. Source of
// truth for OAuth sign-in identity, so a user can have multiple providers
// and the provider's email can differ from their login email.
export const authProvider = pgEnum('auth_provider', ['google']);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    // The provider's stable account id (for Google, the `sub`).
    providerAccountId: text('provider_account_id').notNull(),
    // The provider account's email (informational; may differ from login).
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // One external account maps to at most one user.
    uniqueIndex('accounts_provider_account_unique').on(
      t.provider,
      t.providerAccountId,
    ),
    // At most one account per (user, provider) — makes "one Google account
    // per user" a DB invariant, not just an app-level check. Its leading
    // `user_id` column also serves the per-user lookups.
    uniqueIndex('accounts_user_provider_unique').on(t.userId, t.provider),
  ],
);

// Single-use, expiring password-reset tokens. Only the token's hash is
// stored; the raw token lives only in the emailed link.
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('password_reset_tokens_user_idx').on(t.userId)],
);

// ── Bands + membership ───────────────────────────────────────────────
export const bands = pgTable('bands', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const bandMembers = pgTable(
  'band_members',
  {
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: bandRole('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bandId, t.userId] }),
    index('band_members_user_idx').on(t.userId),
  ],
);

// Pending band invitations keyed to an email address. The raw token lives
// only in the shared link; we store its SHA-256 hash (like reset tokens).
// Single-use: `acceptedAt`/`acceptedBy` are set when redeemed. At most one
// *pending* invite per (band, email) — the data layer refreshes on re-invite.
export const bandInvites = pgTable(
  'band_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: bandRole('role').notNull().default('member'),
    invitedBy: uuid('invited_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('band_invites_band_idx').on(t.bandId)],
);

// ── Conversations ────────────────────────────────────────────────────
// One row per (band, Drive audio file). The audio bytes stay in Drive;
// this row owns the conversation-level state (closed, last activity).
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    driveAudioFileId: text('drive_audio_file_id').notNull(),
    audioFileName: text('audio_file_name'), // denormalized snapshot
    // Optional song metadata — all start blank, none are required.
    // Who the song is originally by, for covers. Free text: the original
    // artist usually isn't a band in this app, so there's nothing to link to.
    originalArtist: text('original_artist'),
    bpm: integer('bpm'), // tempo in beats per minute
    key: text('song_key'), // musical key, free text (e.g. "Am", "C#")
    closed: boolean('closed').notNull().default(false),
    // Archived songs stay in the band but move to a separate list.
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('conversations_band_audio_unique').on(
      t.bandId,
      t.driveAudioFileId,
    ),
    index('conversations_band_idx').on(t.bandId),
    index('conversations_updated_idx').on(t.updatedAt),
  ],
);

// ── Notifications (Home activity feed) ───────────────────────────────
// One row per noteworthy event, scoped to a band; recipients are that
// band's members (resolved at query time via membership). The acting user
// is recorded so they can be excluded from their own notifications.
// Actor/band/subject labels are snapshotted so the feed still reads well
// after the underlying row is renamed or deleted.
export const notificationKind = pgEnum('notification_kind', [
  'song-comment',
  'chat-message',
  'event-added',
  'song-updated',
  'event-updated',
  'band-updated',
  'poll-created',
  'poll-closed',
  'poll-updated',
  'poll-cancelled',
  'poll-auto-closed',
  'setlist-created',
  'audio-added',
  'song-created',
  'album-created',
  'note-pinned',
  'note-unpinned',
  'todo-assigned',
  'todo-completed',
  'todo-cancelled',
  'todo-taken-private',
]);

// What a notification points at, for building its link.
export const notificationSubject = pgEnum('notification_subject', [
  'conversation',
  'event',
  'band',
  'poll',
  'setlist',
  'album',
  'note',
  'todo',
]);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorName: text('actor_name'),
    /**
     * Who this is for, when it's for one person.
     *
     * Null is the original behaviour and still the common case: the row is a
     * broadcast that every member of the band sees. Set, and only that user
     * does — the feed, the unread count and the push fan-out all honour it.
     *
     * Added for todos, where "you've been assigned this" is addressed to one
     * person and telling the whole band both misreads and multiplies the
     * push by the size of the band.
     */
    recipientId: uuid('recipient_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    bandName: text('band_name'),
    kind: notificationKind('kind').notNull(),
    subjectType: notificationSubject('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    subjectLabel: text('subject_label'),
    /**
     * Uploader's local calendar day ("2026-08-05"), on upload rollups only.
     *
     * The grouping key for "one notification per band per day". It can't be
     * derived from `created_at`: that's an instant, and the day it falls in
     * depends on the reader's offset — a 7pm upload in UTC-6 is already
     * tomorrow to the database. Storing the day the uploader saw keeps
     * grouping, the row's link, and playback all agreeing on one answer.
     */
    day: text('day'),
    /**
     * Set once a rollup has more than one uploader.
     *
     * The row can only name one actor, so a day several people contributed to
     * would credit whoever went last. Rather than pick, the feed drops the
     * name entirely when this is set.
     */
    multiActor: boolean('multi_actor').notNull().default(false),
    /**
     * How many uploads a rollup stands for.
     *
     * The count used to live only inside `subject_label` ("5 uploads") and be
     * parsed back out to increment it, which made every addition a
     * read-modify-write: two uploads landing together both read 5 and both
     * wrote 6. Here it can be incremented in the same statement that finds the
     * row. The label is now display text derived from it, not the storage.
     *
     * 1 for non-rollup rows, where it means nothing.
     */
    uploadCount: integer('upload_count').notNull().default(1),
    /**
     * Which fields an edit touched, e.g. `['date','time']` — what turns
     * "updated the event" into "updated the date and time on it".
     *
     * Field *tokens*, deliberately, not a rendered sentence: the wording lives
     * in the UI, so the feed and a push can phrase the same row differently
     * and the plural rules can be changed later without rewriting rows. Null
     * on everything written before this existed, which is why every phrasing
     * site keeps its old generic branch as a fallback.
     */
    changedFields: text('changed_fields').array(),
    /**
     * What the subject was called before, on renames only — so a notification
     * can say "renamed Blue Room to Wildfire" rather than naming the result
     * alone. `subject_label` always holds the *current* name.
     */
    previousLabel: text('previous_label'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Partial: only targeted rows are looked up this way, and they are a
    // small minority — broadcasts are found through band_id.
    index('notifications_recipient_idx')
      .on(t.recipientId)
      .where(sql`recipient_id is not null`),
    index('notifications_band_created_idx').on(t.bandId, t.createdAt),
    // Finding the band's rollup for a given day, on every upload.
    index('notifications_band_day_idx').on(t.bandId, t.day),
    index('notifications_created_idx').on(t.createdAt),
    // At most one rollup per band per day, enforced by the database rather
    // than by the reading half of a read-then-write. This is the index
    // `notifyUploadBatch`'s ON CONFLICT infers, so its predicate has to stay
    // in step with that query's.
    uniqueIndex('notifications_band_day_rollup_unique')
      .on(t.bandId, t.day)
      .where(sql`${t.kind} = 'audio-added' and ${t.subjectId} is null`),
  ],
);

// Per-user "last seen" marker for the notification feed (one row per user).
export const notificationReads = pgTable('notification_reads', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
});

// Per-user muted notification kinds. Presence of a row means that kind is
// muted for the user; the default (no rows) is "everything on". Applied as
// a read-time filter on the feed + unread count.
export const notificationMutes = pgTable(
  'notification_mutes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

// A kind the user doesn't want pushed to their devices, independent of the
// in-app feed: it still appears in the feed (unless also in notification_mutes)
// but no push is sent. An in-app mute already suppresses push, so effective
// push = kind in NEITHER table.
export const pushMutes = pgTable(
  'push_mutes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

// ── Band messages (general chat) ─────────────────────────────────────
// A flat, band-wide message thread (not tied to a song). Any member can
// post; authors (or band owners) can soft-delete. Ordered by createdAt.
export const bandMessages = pgTable(
  'band_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Set when the body is edited (null until then) so the UI can show
    // "edited" without conflating it with the always-present updatedAt.
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('band_messages_band_created_idx').on(t.bandId, t.createdAt)],
);

// @-mentions on a band message → the mentioned users (band members).
export const bandMessageMentions = pgTable(
  'band_message_mentions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => bandMessages.id, { onDelete: 'cascade' }),
    mentionedUserId: uuid('mentioned_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.mentionedUserId] }),
    index('band_message_mentions_user_idx').on(t.mentionedUserId),
  ],
);

// Per-user read marker for a band's chat (drives the unread badge). One
// row per (user, band); lastSeenAt is DB-clock stamped.
export const bandChatReads = pgTable(
  'band_chat_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bandId] })],
);

// ── Notes (threaded) ─────────────────────────────────────────────────
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    // Self-reference needs the explicit AnyPgColumn return type.
    parentNoteId: uuid('parent_note_id').references(
      (): AnyPgColumn => notes.id,
      { onDelete: 'cascade' },
    ),
    timestampMs: integer('timestamp_ms').notNull(),
    body: text('body').notNull(),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('notes_conversation_idx').on(t.conversationId),
    index('notes_parent_idx').on(t.parentNoteId),
  ],
);

// ── Mentions ─────────────────────────────────────────────────────────
export const noteMentions = pgTable(
  'note_mentions',
  {
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    mentionedUserId: uuid('mentioned_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.mentionedUserId] }),
    index('note_mentions_user_idx').on(t.mentionedUserId),
  ],
);

// ── Activity log ─────────────────────────────────────────────────────
export const activityLog = pgTable(
  'activity_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    kind: activityKind('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('activity_log_conversation_idx').on(t.conversationId)],
);

// ── Per-user read state (badges) ─────────────────────────────────────
export const conversationReads = pgTable(
  'conversation_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.conversationId] })],
);

// ── Song files (binary, stored in Postgres) ──────────────────────────
// The audio and sheet music for a song/conversation, owned by us rather
// than referenced in Drive. Sheet music is one row per conversation.
// Audio supports multiple *versions* per conversation (e.g. studio, live,
// acoustic); exactly one is flagged `isDefault` and is what the player
// loads by default.
export const songFileKind = pgEnum('song_file_kind', ['audio', 'sheet_music']);

export const songFiles = pgTable(
  'song_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: songFileKind('kind').notNull(),
    // Bytes live in object storage (S3/R2), addressed by storageKey.
    storageKey: text('storage_key'),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    // Audio duration in whole seconds, parsed on upload (null for
    // non-audio or when it couldn't be determined).
    songLength: integer('song_length'),
    // The default audio version for a song — exactly one per conversation
    // among its audio rows (enforced by a partial unique index below).
    // Always false for sheet music.
    isDefault: boolean('is_default').notNull().default(false),
    // Optional human label for an audio version ("Live 2024", "Acoustic").
    label: text('label'),
    // Provenance: the Drive file this was imported from, if any.
    driveFileId: text('drive_file_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('song_files_conversation_idx').on(t.conversationId),
    // At most one *default* version per conversation, for each kind. Audio and
    // sheet music can both have multiple versions; exactly one is the default.
    uniqueIndex('song_files_default_audio_unique')
      .on(t.conversationId)
      .where(sql`kind = 'audio' and is_default`),
    uniqueIndex('song_files_default_sheet_unique')
      .on(t.conversationId)
      .where(sql`kind = 'sheet_music' and is_default`),
  ],
);

// Each user's chosen sheet-music version per song (so members can view the
// chart they want — e.g. a transposed or instrument-specific version — and it
// sticks across sessions/devices). Falls back to the song's default version
// when there's no row (or the chosen version was deleted, which cascades).
export const sheetVersionPrefs = pgTable(
  'sheet_version_prefs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => songFiles.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.conversationId] })],
);

// ── Setlists ─────────────────────────────────────────────────────────
// A named, ordered list of a band's songs. Any band member can create or
// edit one. Membership in the owning band is the access scope.
export const setlists = pgTable(
  'setlists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Archived setlists are hidden from the active list and can't be picked
    // as targets (add-to-setlist, event association). Reversible.
    archived: boolean('archived').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('setlists_band_idx').on(t.bandId)],
);

// Items in a setlist, ordered by `position`. An item is either a song
// (conversationId set) or a free-standing marker like a set break or a
// custom entry (conversationId null, `label` holds its name). A given song
// appears at most once per setlist; markers can repeat.
export const setlistSongs = pgTable(
  'setlist_songs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    setlistId: uuid('setlist_id')
      .notNull()
      .references(() => setlists.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    // Name for non-song items (set break / custom); null for songs.
    label: text('label'),
    position: integer('position').notNull(),
  },
  (t) => [
    index('setlist_songs_setlist_idx').on(t.setlistId),
    // A song appears at most once per setlist (markers are exempt).
    uniqueIndex('setlist_songs_setlist_conversation_unique')
      .on(t.setlistId, t.conversationId)
      .where(sql`conversation_id is not null`),
  ],
);

// ── Albums ───────────────────────────────────────────────────────────
// A named, ordered collection of a band's songs — deliberately its own thing
// rather than a flavour of setlist. Setlists are performance artifacts and get
// dragged through Practice, Live, events and offline downloads; albums are how
// a band files its recordings. Sharing one table would mean every existing
// setlist query silently returning albums unless it remembered to filter, and
// there are a lot of them.
//
// The difference that matters in the data: an album track can pin a *specific*
// audio version, where a setlist always plays the song's current default.
export const albums = pgTable(
  'albums',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Mirrors setlists: hidden from the active list, reversible.
    archived: boolean('archived').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('albums_band_idx').on(t.bandId)],
);

/**
 * A song's place on an album, optionally pinned to one audio version.
 *
 * Unlike `setlist_songs` there is no unique index on (album, song): a song may
 * appear more than once on one album, which is the point of pinning — the same
 * recording can sit in the running order twice as different takes.
 *
 * The three pin columns move together and encode three states without a join:
 *
 *   - all null                          → follow the song's current default
 *   - `audioVersionId` set              → pinned, and the version still exists
 *   - `audioVersionId` null, snapshot   → pinned, and the version was deleted
 *     set
 *
 * That last state is why `audioVersionId` is ON DELETE SET NULL rather than
 * CASCADE, and why the snapshot exists at all: deleting an audio version hard-
 * deletes its row and its bytes (see `deleteAudioVersion`), so without a copy
 * of the name there would be nothing left to tell the user what they lost. Same
 * idea as `user_note_links.label`. Playback falls back to the song's default
 * and the album flags the track until someone resolves it.
 */
export const albumTracks = pgTable(
  'album_tracks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    // Cascades, unlike the version pin above: a deleted song is gone from the
    // whole app, so a tombstone for it would be debris nobody can act on.
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** The pinned version, or null to follow the song's default. */
    audioVersionId: uuid('audio_version_id').references(() => songFiles.id, {
      onDelete: 'set null',
    }),
    /** Snapshot of the pinned version, kept readable after it's deleted. */
    pinnedFileName: text('pinned_file_name'),
    pinnedLabel: text('pinned_label'),
    /** Seconds, so a lost pin can still show the length it had. */
    pinnedLength: integer('pinned_length'),
  },
  (t) => [index('album_tracks_album_idx').on(t.albumId)],
);

// ── Events (calendar) ────────────────────────────────────────────────
// A calendar event owned by a band (chosen at creation). Visible to the
// band's members, plus any users explicitly added via `event_members`.
export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // What kind of event this is — "Show", "Practice", … The UI offers a few
    // presets, but it's free text so a band can name its own; null on events
    // created before types existed, and whenever none is chosen.
    eventType: text('event_type'),
    date: date('date', { mode: 'string' }).notNull(), // YYYY-MM-DD start
    /**
     * Last day of a multi-day event (YYYY-MM-DD), inclusive.
     *
     * Null means the event ends the day it starts, which is what every event
     * written before this column existed meant — so there is no backfill and
     * no default. Read it as `coalesce(end_date, date)`: that expression is
     * the event's real last day, and it's what "is this in range / past /
     * upcoming" has to compare against, never `date` alone.
     */
    endDate: date('end_date', { mode: 'string' }),
    time: text('time'), // HH:MM start, optional
    // HH:MM end. Only meaningful with a start `time`; defaults to two hours
    // after the start. Null for all-day (no start) events. On a multi-day
    // event it is a time on `end_date`, not on `date`.
    endTime: text('end_time'),
    location: text('location'),
    // Public-facing info about the event.
    details: text('details'),
    // The band's private observations (not shared to the calendar feed).
    notes: text('notes'),
    // Optional associated setlist (must belong to the same band). Cleared
    // if that setlist is deleted.
    setlistId: uuid('setlist_id').references(() => setlists.id, {
      onDelete: 'set null',
    }),
    // Optional associated venue (a saved place, must belong to the same band).
    // Cleared if that venue is deleted.
    venueId: uuid('venue_id').references(() => venues.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('events_band_idx').on(t.bandId),
    index('events_date_idx').on(t.date),
    // Range/past/upcoming all filter on the event's last day, which is
    // `coalesce(end_date, date)` — index the expression itself so those
    // queries stay index-backed rather than scanning.
    index('events_end_date_idx').on(sql`coalesce(${t.endDate}, ${t.date})`),
  ],
);

// A venue a band saves for later (a place they play): a name plus optional
// contact details and free-form notes. Scoped to the band.
export const venues = pgTable(
  'venues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    contactName: text('contact_name'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('venues_band_idx').on(t.bandId)],
);

// A Web Push subscription for one of a user's installed devices/browsers.
// Endpoint is the stable identity (unique); a device that re-subscribes just
// updates its keys. Removed when the user turns push off or the endpoint
// expires (410/404 on send).
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

// A poll the band's members can be asked to weigh in on: a title, optional
// description, and a set of options (stored in poll_options).
export const polls = pgTable(
  'polls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Set when the poll is closed (voting stopped, kept for history). Null
    // while open. Cancelling deletes the row instead.
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('polls_band_idx').on(t.bandId)],
);

export const pollOptions = pgTable(
  'poll_options',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [index('poll_options_poll_idx').on(t.pollId)],
);

// One vote per member per poll (single-choice); re-voting updates the option.
export const pollVotes = pgTable(
  'poll_votes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    optionId: uuid('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('poll_votes_poll_user_unique').on(t.pollId, t.userId),
    index('poll_votes_option_idx').on(t.optionId),
  ],
);

// Extra attendees on an event, beyond the owning band's members. Added by
// email, the same way band members are.
export const eventMembers = pgTable(
  'event_members',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index('event_members_user_idx').on(t.userId),
  ],
);

// A private, revocable token backing a per-user iCalendar subscription feed.
// The token is a bearer capability embedded in the feed URL (calendar apps
// can't log in), so it must be unguessable. Resetting swaps the token, which
// invalidates the previously-shared URL. One feed per user for now; a per-band
// feed could be added later as a second scope.
export const calendarFeeds = pgTable(
  'calendar_feeds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('calendar_feeds_token_unique').on(t.token),
    uniqueIndex('calendar_feeds_user_unique').on(t.userId),
  ],
);
// A member's own note within a band: a title, free text, and any number of
// links out to the band's other objects. Private to its author by default;
// `shared` opens it to the rest of the band, which is the only way anyone
// else ever sees it.
//
// Named `user_notes` to stay clear of `notes`, which is the per-song comment
// thread and unrelated.
export const userNotes = pgTable(
  'user_notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    // False = only the author. True = everyone in the band can read it;
    // editing and deleting stay with the author either way.
    shared: boolean('shared').notNull().default(false),
    /**
     * Held at the top of whichever view the note is in.
     *
     * One flag serves both views because visibility already scopes it: an
     * unshared note is only visible to its author, so its pin is private to
     * them; a shared one is visible to the band, so its pin is the band's.
     * Anyone in the band may pin or unpin a shared note — there is no cap,
     * and the notification feed is what keeps that accountable.
     */
    pinned: boolean('pinned').notNull().default(false),
    /** When it was pinned — the pinned section's sort order. Null if not. */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // The tab's query: this band's notes, mine plus the band's shared ones.
    index('user_notes_band_author_idx').on(t.bandId, t.authorId),
    index('user_notes_band_shared_idx').on(t.bandId, t.shared),
    // Partial: the pinned section and its count both read only pinned rows,
    // which are a small fraction of a band's notes, and both want them
    // newest-pinned first.
    index('user_notes_band_pinned_idx')
      .on(t.bandId, t.pinnedAt.desc())
      .where(sql`pinned`),
  ],
);

export const userNoteLinkKind = pgEnum('user_note_link_kind', [
  'song',
  'event',
  'venue',
  'setlist',
  'poll',
  'other',
]);

// One thing a note points at. Every kind but `other` names a row in a
// different table, so there's no single foreign key to declare — `target_id`
// is unconstrained on purpose. `label` is the target's name as it read when
// the link was made, which keeps a link legible after its target is renamed
// or deleted; `url` carries the free-form `other` kind.
// ── Todos ────────────────────────────────────────────────────────────
export const todoStatus = pgEnum('todo_status', [
  'active',
  'complete',
  'cancelled',
]);

/**
 * A band's todo. Private to its creator until shared, then the band's.
 *
 * Unlike a note, a shared todo is genuinely handed over: anyone in the band
 * can edit, restatus, reassign or delete it. Only the creator or the current
 * owner may take it *back* out of the band, which is the one action that
 * removes it from everyone else's view.
 */
export const todos = pgTable(
  'todos',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => bands.id, { onDelete: 'cascade' }),
    /**
     * Who it belongs to when it isn't shared — and therefore who can see it.
     *
     * Mutable, unusually: an owner who takes a shared todo private becomes
     * its creator, because the alternative is a private todo belonging to
     * someone who can no longer see it.
     */
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: todoStatus('status').notNull().default('active'),
    /** False = only the creator. True = the whole band, and anyone may edit. */
    shared: boolean('shared').notNull().default(false),
    /**
     * Who is doing it. Shared todos only: an unshared todo is its creator's by
     * definition, so a second column saying so could only ever disagree.
     * Null on a shared todo means nobody has claimed it.
     */
    ownerId: uuid('owner_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Optional due date, YYYY-MM-DD. No time — todos are due on a day. */
    deadline: date('deadline', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // The tab reads one status at a time, in its own collapsible section.
    index('todos_band_status_idx').on(t.bandId, t.status),
    // "Mine": partial, because an owner only means anything once shared.
    index('todos_band_owner_idx')
      .on(t.bandId, t.ownerId)
      .where(sql`shared`),
    index('todos_band_creator_idx').on(t.bandId, t.creatorId),
  ],
);

/**
 * A todo's links. Same shape and the same kinds as a note's — the logic in
 * `lib/note-links.ts` is shared — but its own table so the foreign key stays
 * real rather than becoming a polymorphic pair nothing can enforce.
 */
export const todoLinks = pgTable(
  'todo_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    kind: userNoteLinkKind('kind').notNull(),
    targetId: uuid('target_id'),
    url: text('url'),
    label: text('label').notNull(),
    practice: boolean('practice').notNull().default(false),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('todo_links_todo_idx').on(t.todoId)],
);

export const userNoteLinks = pgTable(
  'user_note_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => userNotes.id, { onDelete: 'cascade' }),
    kind: userNoteLinkKind('kind').notNull(),
    /** The linked row's id. Null for `other`. */
    targetId: uuid('target_id'),
    /** Free-form destination for `other` — a pasted URL or reference. */
    url: text('url'),
    label: text('label').notNull(),
    /**
     * Song links only: point at the song's Practice screen instead of its
     * page.
     *
     * Its own column rather than a second link kind, because it isn't a
     * different sort of thing to link to — it's the same song, opened
     * differently. A kind would have split "Song" in two everywhere the
     * picker, the Type dropdown and the chip label mention it.
     */
    practice: boolean('practice').notNull().default(false),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('user_note_links_note_idx').on(t.noteId)],
);
