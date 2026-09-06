import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  ne,
  sum,
} from 'drizzle-orm';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { db } from './index';
import { conversations, sheetVersionPrefs, songFiles } from './schema';
import {
  audioVersionKey,
  getBucket,
  getS3Client,
  sheetVersionKey,
} from '../storage/s3';

/**
 * Song file storage.
 *
 * Bytes live in S3-compatible object storage (Cloudflare R2 in prod,
 * MinIO in dev); Postgres holds only the metadata + the object key. This
 * keeps the database small regardless of the audio library's size.
 *
 * Object writes and DB rows aren't a single transaction, so cleanup is
 * best-effort with a bias toward orphaned OBJECTS over dangling rows:
 * deletes drop the row first, then the object (a leaked object is caught
 * by the sweep script; a row pointing at a missing object is worse).
 */

export type SongFileKind = (typeof songFiles.kind.enumValues)[number];

// Guard version ids before they hit a `uuid`-typed column: a malformed id
// would make Postgres throw ("invalid input syntax for type uuid") rather
// than simply miss, turning a not-found into a 500.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface SongFileMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Audio duration in whole seconds; null for non-audio / unknown. */
  songLength: number | null;
  /** ISO timestamp of the last write — a stable cache-bust token. */
  updatedAt: string;
}

/** Stream a body straight to object storage without buffering it in memory.
 * `contentLength` is required (S3 streams a body of known length); callers
 * always know it (`file.size` locally, Drive's declared size). */
async function putObjectStream(
  key: string,
  body: Readable,
  contentType: string,
  contentLength: number,
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
  );
}

// How many leading bytes to pull back for the duration probe.
const DURATION_PROBE_BYTES = 1024 * 1024; // 1 MB

async function readUpTo(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    chunks.push(b);
    total += b.length;
    if (total >= max) break;
  }
  body.destroy();
  return Buffer.concat(chunks);
}

function isMp3(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === 'audio/mpeg' || m === 'audio/mp3' || m === 'audio/mpeg3';
}

// MPEG audio bitrate tables (kbps), indexed by the 4-bit bitrate field.
// Index 0 = "free", 15 = "bad"; both are unusable → treated as 0.
const BITRATES_V1_L1 = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
];
const BITRATES_V1_L2 = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
];
const BITRATES_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATES_V2_L1 = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
];
const BITRATES_V2_L23 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

/** Byte length of an ID3v2 tag at the start of `buf`, or 0 if none. */
function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33)
    return 0; // not "ID3"
  const synchsafe =
    (buf[6]! & 0x7f) * 0x200000 +
    (buf[7]! & 0x7f) * 0x4000 +
    (buf[8]! & 0x7f) * 0x80 +
    (buf[9]! & 0x7f);
  const footer = buf[5]! & 0x10 ? 10 : 0;
  return 10 + synchsafe + footer;
}

/** Parse the MPEG audio frame header at `off`, or null if it isn't valid. */
function parseFrameHeader(buf: Buffer, off: number) {
  if (off + 4 > buf.length) return null;
  const b1 = buf[off + 1]!;
  const b2 = buf[off + 2]!;
  const b3 = buf[off + 3]!;
  if (buf[off] !== 0xff || (b1 & 0xe0) !== 0xe0) return null; // frame sync
  const versionId = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  const layer = (b1 >> 1) & 0x03; // 3=I, 2=II, 1=III, 0=reserved
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03; // 3 = mono
  if (versionId === 1 || layer === 0 || sampleRateIdx === 3) return null;

  const table =
    versionId === 3
      ? layer === 3
        ? BITRATES_V1_L1
        : layer === 2
          ? BITRATES_V1_L2
          : BITRATES_V1_L3
      : layer === 3
        ? BITRATES_V2_L1
        : BITRATES_V2_L23;
  const bitrateKbps = table[bitrateIdx]!;
  const sampleRate = SAMPLE_RATES[versionId]![sampleRateIdx]!;
  if (!bitrateKbps || !sampleRate) return null;

  // Frame length in bytes (used to validate the next sync).
  const samplesPer8 =
    layer === 3 ? 48 : versionId === 3 || layer === 2 ? 144 : 72;
  const slot = layer === 3 ? 4 : 1;
  const frameLength =
    Math.floor((samplesPer8 * bitrateKbps * 1000) / sampleRate) +
    padding * slot;

  return { versionId, channelMode, bitrateKbps, sampleRate, frameLength };
}

/**
 * Duration (seconds) for a *headerless CBR* MP3, computed from the first
 * frame's bitrate and the real file size. Returns null for anything else —
 * VBR / files carrying a Xing/Info/VBRI header (which `music-metadata` reads
 * accurately), or when a valid frame can't be found in the probe window. This
 * is the fallback for the case where a truncated buffer makes music-metadata
 * collapse a CBR duration to ~(probe-window ÷ bitrate).
 */
function estimateMp3CbrDurationSec(
  head: Buffer,
  sizeBytes: number,
): number | null {
  const start = id3v2Size(head);
  // Find the first frame whose next frame also syncs (guards against false hits).
  let off = -1;
  for (let i = start; i + 4 <= head.length; i++) {
    if (head[i] !== 0xff) continue;
    const h = parseFrameHeader(head, i);
    if (!h) continue;
    const next = i + h.frameLength;
    if (next + 2 > head.length || parseFrameHeader(head, next)) {
      off = i;
      break;
    }
  }
  if (off < 0) return null;

  const h = parseFrameHeader(head, off)!;
  // A Xing/Info (or VBRI) header means music-metadata gets the exact duration.
  const sideInfo =
    h.versionId === 3
      ? h.channelMode === 3
        ? 17
        : 32
      : h.channelMode === 3
        ? 9
        : 17;
  const xingAt = off + 4 + sideInfo;
  const tag = head.subarray(xingAt, xingAt + 4).toString('latin1');
  const vbri = head.subarray(off + 4 + 32, off + 4 + 36).toString('latin1');
  if (tag === 'Xing' || tag === 'Info' || vbri === 'VBRI') return null;

  const audioBytes = sizeBytes - off;
  if (audioBytes <= 0) return null;
  const seconds = (audioBytes * 8) / (h.bitrateKbps * 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

function isWav(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return (
    m === 'audio/wav' ||
    m === 'audio/x-wav' ||
    m === 'audio/wave' ||
    m === 'audio/vnd.wave'
  );
}

/**
 * Duration (seconds) for a WAV from its header — the `fmt ` chunk's byteRate
 * and the `data` chunk's size (declared, or the remainder of the file). Only
 * the headers are needed, so it's accurate from the truncated probe buffer,
 * unlike `music-metadata`, which computes a large WAV's duration from the
 * bytes actually present (~probe-window ÷ byteRate). Returns null if the
 * header can't be parsed.
 */
function estimateWavDurationSec(
  head: Buffer,
  sizeBytes: number,
): number | null {
  if (head.length < 12) return null;
  if (head.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (head.toString('latin1', 8, 12) !== 'WAVE') return null;

  let byteRate = 0;
  let dataStart = -1;
  let dataDeclared = 0;
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.toString('latin1', off, off + 4);
    const size = head.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= head.length) {
      byteRate = head.readUInt32LE(body + 8);
    } else if (id === 'data') {
      dataStart = body;
      dataDeclared = size;
      break; // audio data — no need to scan further
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (byteRate <= 0 || dataStart < 0) return null;

  // Prefer the declared data size when plausible; else the rest of the file
  // (streamed WAVs sometimes write 0 or a bogus size).
  const remaining = sizeBytes - dataStart;
  const dataSize =
    dataDeclared > 0 && dataDeclared <= remaining ? dataDeclared : remaining;
  if (dataSize <= 0) return null;
  const seconds = dataSize / byteRate;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

/**
 * Best-effort audio duration WITHOUT holding the whole file in memory: read
 * just the leading bytes back from storage and parse them, passing the real
 * total size as a hint. That's enough for header/size-based formats (MP3,
 * fast-start MP4); anything it can't determine returns null (as before).
 *
 * For MP3 and WAV we prefer our own header-based estimate: `music-metadata`
 * mis-estimates both from a truncated buffer (headerless CBR MP3 and large
 * WAVs collapse to ~probe-window ÷ bit/byte-rate).
 */
async function probeAudioDuration(
  key: string,
  mimeType: string,
  sizeBytes: number,
): Promise<number | null> {
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({
        Bucket: getBucket(),
        Key: key,
        Range: `bytes=0-${DURATION_PROBE_BYTES - 1}`,
      }),
    );
    const head = await readUpTo(res.Body as Readable, DURATION_PROBE_BYTES);

    if (isMp3(mimeType)) {
      const cbr = estimateMp3CbrDurationSec(head, sizeBytes);
      if (cbr != null) return cbr;
    }
    if (isWav(mimeType)) {
      const wav = estimateWavDurationSec(head, sizeBytes);
      if (wav != null) return wav;
    }

    const { parseBuffer } = await import('music-metadata');
    const meta = await parseBuffer(head, { mimeType, size: sizeBytes });
    const dur = meta.format.duration;
    return typeof dur === 'number' && Number.isFinite(dur)
      ? Math.round(dur)
      : null;
  } catch {
    return null;
  }
}

// Resolve the "current" row for a (conversation, kind). Both audio and sheet
// music can have several versions, so we resolve to the default — that's what
// the player and default metadata reads target.
async function getRow(conversationId: string, kind: SongFileKind) {
  const where = and(
    eq(songFiles.conversationId, conversationId),
    eq(songFiles.kind, kind),
    eq(songFiles.isDefault, true),
  );
  const [row] = await db
    .select({
      storageKey: songFiles.storageKey,
      fileName: songFiles.fileName,
      mimeType: songFiles.mimeType,
      sizeBytes: songFiles.sizeBytes,
      songLength: songFiles.songLength,
      updatedAt: songFiles.updatedAt,
    })
    .from(songFiles)
    .where(where)
    .limit(1);
  return row ?? null;
}

/**
 * Everything serving one file takes: what to say about it, and where its
 * bytes are.
 *
 * Serving used to resolve those separately — headers from a `…Meta` call,
 * bytes from a `stream…` call — which ran the same lookup twice on every
 * request, and audio playback is many Range requests per track. They're one
 * row; read it once and pass it along.
 */
export interface SongFileTarget extends SongFileMeta {
  /** Null for a row whose object was never stored. */
  storageKey: string | null;
}

function toTarget(row: {
  storageKey: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  songLength: number | null;
  updatedAt: Date;
}): SongFileTarget {
  return {
    storageKey: row.storageKey,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    songLength: row.songLength,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The describing half of a target, for callers that don't serve bytes. */
function toMeta(target: SongFileTarget): SongFileMeta {
  return {
    fileName: target.fileName,
    mimeType: target.mimeType,
    sizeBytes: target.sizeBytes,
    songLength: target.songLength,
    updatedAt: target.updatedAt,
  };
}

/** The song's default file of this kind, ready to serve. */
export async function getSongFileTarget(
  conversationId: string,
  kind: SongFileKind,
): Promise<SongFileTarget | null> {
  const row = await getRow(conversationId, kind);
  return row ? toTarget(row) : null;
}

export async function getSongFileMeta(
  conversationId: string,
  kind: SongFileKind,
): Promise<SongFileMeta | null> {
  const target = await getSongFileTarget(conversationId, kind);
  return target ? toMeta(target) : null;
}

export async function hasSongFile(
  conversationId: string,
  kind: SongFileKind,
): Promise<boolean> {
  return (await getSongFileMeta(conversationId, kind)) !== null;
}

const META_COLUMNS = {
  fileName: songFiles.fileName,
  mimeType: songFiles.mimeType,
  sizeBytes: songFiles.sizeBytes,
  songLength: songFiles.songLength,
  updatedAt: songFiles.updatedAt,
} as const;

const TARGET_COLUMNS = {
  ...META_COLUMNS,
  storageKey: songFiles.storageKey,
} as const;

/** One named version of a song's file, scoped to its conversation. */
async function getVersionTarget(
  conversationId: string,
  versionId: string,
  kind: SongFileKind,
): Promise<SongFileTarget | null> {
  if (!isUuid(versionId)) return null;
  const [row] = await db
    .select(TARGET_COLUMNS)
    .from(songFiles)
    .where(
      and(
        eq(songFiles.id, versionId),
        eq(songFiles.conversationId, conversationId),
        eq(songFiles.kind, kind),
      ),
    )
    .limit(1);
  return row ? toTarget(row) : null;
}

// Sheet music is multi-version (see `addSheetVersion` and the sheet-music
// versions section below); the old single-sheet `putSheetMusic` was removed.

export interface AudioVersion {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  songLength: number | null;
  isDefault: boolean;
  label: string | null;
  updatedAt: string;
}

/**
 * Add a new audio version to a song.
 *
 * The first audio version always becomes the default, since a song with audio
 * and no default would play nothing. After that it depends on `makeDefault`.
 *
 * The check, the demotion and the insert share one transaction: the partial
 * unique index permits a single default per song, so clearing the old one and
 * setting the new one in separate statements would leave a window with none —
 * and a concurrent read there would see a song whose audio can't be played.
 */
export async function addAudioVersion(input: {
  conversationId: string;
  body: Readable;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
  label?: string | null;
  driveFileId?: string | null;
  /**
   * Promote this version to the song's default, demoting whatever held it.
   *
   * Omitted means the old behaviour — only the first version is default — so
   * callers that create a song from an upload are unaffected.
   */
  makeDefault?: boolean;
}): Promise<AudioVersion> {
  const key = audioVersionKey(input.conversationId, randomUUID());
  await putObjectStream(key, input.body, input.mimeType, input.sizeBytes);
  // Duration is derived after the fact from the stored object's header, so
  // we never hold the whole file in memory.
  const songLength = await probeAudioDuration(
    key,
    input.mimeType,
    input.sizeBytes,
  );

  const row = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: songFiles.id })
      .from(songFiles)
      .where(
        and(
          eq(songFiles.conversationId, input.conversationId),
          eq(songFiles.kind, 'audio'),
          eq(songFiles.isDefault, true),
        ),
      )
      .limit(1);
    const isDefault = existing.length === 0 || input.makeDefault === true;
    // Demote the incumbent before inserting, or the index rejects the second
    // default row.
    if (isDefault && existing.length > 0) {
      await tx
        .update(songFiles)
        .set({ isDefault: false })
        .where(
          and(
            eq(songFiles.conversationId, input.conversationId),
            eq(songFiles.kind, 'audio'),
            eq(songFiles.isDefault, true),
          ),
        );
    }

    const [inserted] = await tx
      .insert(songFiles)
      .values({
        conversationId: input.conversationId,
        kind: 'audio',
        storageKey: key,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        songLength,
        isDefault,
        label: input.label ?? null,
        driveFileId: input.driveFileId ?? null,
      })
      .returning({
        id: songFiles.id,
        fileName: songFiles.fileName,
        mimeType: songFiles.mimeType,
        sizeBytes: songFiles.sizeBytes,
        songLength: songFiles.songLength,
        isDefault: songFiles.isDefault,
        label: songFiles.label,
        updatedAt: songFiles.updatedAt,
      });
    return inserted!;
  });

  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Re-probe and update `song_length` for every stored audio file. One-off
 * maintenance for rows written before the CBR-MP3 duration fix. Returns the
 * count scanned and the count actually changed; reports each change via
 * `onChange` if given.
 */
export async function reprobeAudioDurations(opts?: {
  onChange?: (info: {
    fileName: string;
    from: number | null;
    to: number | null;
  }) => void;
}): Promise<{ scanned: number; updated: number }> {
  const rows = await db
    .select({
      id: songFiles.id,
      storageKey: songFiles.storageKey,
      fileName: songFiles.fileName,
      mimeType: songFiles.mimeType,
      sizeBytes: songFiles.sizeBytes,
      songLength: songFiles.songLength,
    })
    .from(songFiles)
    .where(eq(songFiles.kind, 'audio'));

  let updated = 0;
  for (const r of rows) {
    if (!r.storageKey) continue;
    const dur = await probeAudioDuration(r.storageKey, r.mimeType, r.sizeBytes);
    if (dur !== r.songLength) {
      await db
        .update(songFiles)
        .set({ songLength: dur })
        .where(eq(songFiles.id, r.id));
      updated++;
      opts?.onChange?.({ fileName: r.fileName, from: r.songLength, to: dur });
    }
  }
  return { scanned: rows.length, updated };
}

/**
 * One uploaded audio file: a song's first upload or a later version of it.
 *
 * The Uploads history and the daily rollup are both about *files*, not songs
 * — adding a second take is an upload, and a song created without audio isn't
 * one — so they read this rather than the conversation list.
 */
/** One stored file, for the band's File management page. */
export interface BandFile {
  /** The `song_files` row — one *version*, not the song. */
  id: string;
  conversationId: string;
  /** The song this belongs to. */
  songName: string;
  /** Archived songs stay in the band but move to a separate list. */
  songArchived: boolean;
  kind: SongFileKind;
  fileName: string;
  label: string | null;
  mimeType: string;
  sizeBytes: number;
  /** Whether this is the song's default version of its kind. */
  isDefault: boolean;
  createdAt: string;
}

/**
 * What a band is using, in bytes.
 *
 * Summed from `song_files`, which is what a member can actually see and act
 * on. It can drift below what the bucket holds: object deletes are
 * best-effort rather than transactional with the database, so a failed delete
 * leaves bytes behind that no row points at. `scripts/r2-sweep.mjs` reclaims
 * those. Reporting the bucket instead would show people a number they have no
 * way to reduce.
 */
export async function bandStorageUsage(
  bandId: string,
): Promise<{ bytes: number; files: number }> {
  const [row] = await db
    .select({
      // `sum` returns a numeric string, and null for a band with no files.
      bytes: sum(songFiles.sizeBytes),
      files: count(songFiles.id),
    })
    .from(songFiles)
    .innerJoin(conversations, eq(conversations.id, songFiles.conversationId))
    .where(eq(conversations.bandId, bandId));

  return { bytes: Number(row?.bytes ?? 0), files: Number(row?.files ?? 0) };
}

/**
 * Every stored file in a band, newest first.
 *
 * Deliberately not an extension of `listBandUploads`: that one is audio-only
 * and shapes its rows for the Uploads tab, which would break if this grew new
 * columns onto it. This returns both kinds with the sizes and the song's
 * archived state, and is unpaged — the page sorts and filters in the browser,
 * so it needs the whole set.
 */
export async function listBandFiles(bandId: string): Promise<BandFile[]> {
  const rows = await db
    .select({
      id: songFiles.id,
      conversationId: songFiles.conversationId,
      songName: conversations.audioFileName,
      songArchived: conversations.archived,
      kind: songFiles.kind,
      fileName: songFiles.fileName,
      label: songFiles.label,
      mimeType: songFiles.mimeType,
      sizeBytes: songFiles.sizeBytes,
      isDefault: songFiles.isDefault,
      createdAt: songFiles.createdAt,
    })
    .from(songFiles)
    .innerJoin(conversations, eq(conversations.id, songFiles.conversationId))
    .where(eq(conversations.bandId, bandId))
    // Ties broken by id, so two files uploaded in the same millisecond — which
    // a bulk import does routinely — keep a stable order.
    .orderBy(desc(songFiles.createdAt), desc(songFiles.id));

  return rows.map((r) => ({
    ...r,
    songName: r.songName ?? r.fileName,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Delete a set of files, refusing anything outside the given band.
 *
 * The band scope is the security boundary: ids arrive from a client, so the
 * rows are resolved against `bandId` here rather than trusted. Anything that
 * doesn't resolve is reported as skipped instead of failing the batch — a
 * stale id from a page someone left open shouldn't block the rest.
 *
 * Each delete goes through the existing per-kind helpers, so a removed
 * default still promotes a replacement and the bytes still leave storage.
 */
export async function deleteBandFiles(
  bandId: string,
  fileIds: string[],
): Promise<{ deleted: string[]; skipped: string[]; freedBytes: number }> {
  const ids = fileIds.filter(isUuid);
  if (ids.length === 0) return { deleted: [], skipped: fileIds, freedBytes: 0 };

  const rows = await db
    .select({
      id: songFiles.id,
      conversationId: songFiles.conversationId,
      kind: songFiles.kind,
      sizeBytes: songFiles.sizeBytes,
    })
    .from(songFiles)
    .innerJoin(conversations, eq(conversations.id, songFiles.conversationId))
    .where(and(inArray(songFiles.id, ids), eq(conversations.bandId, bandId)));

  const found = new Set(rows.map((r) => r.id));
  const deleted: string[] = [];
  let freedBytes = 0;

  for (const row of rows) {
    const gone =
      row.kind === 'audio'
        ? await deleteAudioVersion(row.conversationId, row.id)
        : await deleteSheetVersion(row.conversationId, row.id);
    if (gone) {
      deleted.push(row.id);
      freedBytes += row.sizeBytes;
    }
  }

  return {
    deleted,
    skipped: fileIds.filter((id) => !found.has(id) || !deleted.includes(id)),
    freedBytes,
  };
}

/** Why deleting a particular file deserves a second look. */
export interface FileWarning {
  fileId: string;
  /**
   * Deleting the current selection leaves this file's song with no audio.
   * Judged against what the song is left with, so selecting every take of a
   * song warns on each of them.
   */
  lastAudio: boolean;
  /** Another member has chosen this sheet as the one they read. */
  chosenByOthers: number;
}

/**
 * The warnings for a set of files about to be deleted.
 *
 * Two set-based queries rather than one per file: a batch delete of thirty
 * files shouldn't be sixty round trips.
 *
 * Only files that warrant a warning appear in the result — an empty array
 * means the whole selection is unremarkable.
 *
 * `chosenByOthers` counts *other* members: your own chosen sheet reverting to
 * the song's default is a consequence you can see, not a surprise you need
 * warning about.
 */
export async function warningsForFiles(
  fileIds: string[],
  viewerId: string,
): Promise<FileWarning[]> {
  const ids = fileIds.filter(isUuid);
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: songFiles.id,
      kind: songFiles.kind,
      conversationId: songFiles.conversationId,
    })
    .from(songFiles)
    .where(inArray(songFiles.id, ids));
  if (rows.length === 0) return [];

  // How much audio each affected song has, so "the last one" is knowable
  // without asking per file.
  const audioConvIds = [
    ...new Set(
      rows.filter((r) => r.kind === 'audio').map((r) => r.conversationId),
    ),
  ];
  const audioCounts = new Map<string, number>();
  if (audioConvIds.length > 0) {
    const counted = await db
      .select({
        conversationId: songFiles.conversationId,
        n: count(songFiles.id),
      })
      .from(songFiles)
      .where(
        and(
          inArray(songFiles.conversationId, audioConvIds),
          eq(songFiles.kind, 'audio'),
        ),
      )
      .groupBy(songFiles.conversationId);
    for (const c of counted) audioCounts.set(c.conversationId, Number(c.n));
  }

  // Sheet music someone else reads. Audio has no per-member choice, so there
  // is no equivalent lookup for it.
  const sheetIds = rows
    .filter((r) => r.kind === 'sheet_music')
    .map((r) => r.id);
  const chosen = new Map<string, number>();
  if (sheetIds.length > 0) {
    const picked = await db
      .select({
        versionId: sheetVersionPrefs.versionId,
        n: count(sheetVersionPrefs.userId),
      })
      .from(sheetVersionPrefs)
      .where(
        and(
          inArray(sheetVersionPrefs.versionId, sheetIds),
          ne(sheetVersionPrefs.userId, viewerId),
        ),
      )
      .groupBy(sheetVersionPrefs.versionId);
    for (const p of picked) chosen.set(p.versionId, Number(p.n));
  }

  // How many of each song's audio files this selection would take with it.
  // The question is what the song is *left* with, so selecting both takes of
  // a two-take song has to warn just as loudly as deleting its only one.
  const selectedPerConv = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== 'audio') continue;
    selectedPerConv.set(
      r.conversationId,
      (selectedPerConv.get(r.conversationId) ?? 0) + 1,
    );
  }

  const out: FileWarning[] = [];
  for (const r of rows) {
    const remaining =
      (audioCounts.get(r.conversationId) ?? 0) -
      (selectedPerConv.get(r.conversationId) ?? 0);
    const lastAudio = r.kind === 'audio' && remaining <= 0;
    const chosenByOthers = chosen.get(r.id) ?? 0;
    if (lastAudio || chosenByOthers > 0)
      out.push({ fileId: r.id, lastAudio, chosenByOthers });
  }
  return out;
}

export interface BandUpload {
  /** The `song_files` row, i.e. this particular version. */
  fileId: string;
  conversationId: string;
  /** The song's name. */
  title: string;
  fileName: string;
  label: string | null;
  mimeType: string;
  songLength: number | null;
  isDefault: boolean;
  /** When this file was uploaded — the day it belongs to. */
  createdAt: string;
  originalArtist: string | null;
  bpm: number | null;
  key: string | null;
}

/**
 * The band's audio files, newest first.
 *
 * Newest first and bounded because this list only grows: a band that has been
 * going a while has thousands of files, and the Uploads tab shows the recent
 * end of them. Callers page with `limit`/`offset` (see `lib/paging`).
 *
 * `from`/`to` fetch one window instead — the per-day page's use. The day being
 * the *viewer's* local day is why the server can't take a day key, but the
 * browser can turn one into the two instants that bound it, and those mean the
 * same thing everywhere.
 */
export async function listBandUploads(
  bandId: string,
  opts: {
    limit?: number;
    offset?: number;
    /** Inclusive lower bound on upload time. */
    from?: Date;
    /** Exclusive upper bound. */
    to?: Date;
  } = {},
): Promise<BandUpload[]> {
  const query = db
    .select({
      fileId: songFiles.id,
      conversationId: songFiles.conversationId,
      title: conversations.audioFileName,
      fileName: songFiles.fileName,
      label: songFiles.label,
      mimeType: songFiles.mimeType,
      songLength: songFiles.songLength,
      isDefault: songFiles.isDefault,
      createdAt: songFiles.createdAt,
      originalArtist: conversations.originalArtist,
      bpm: conversations.bpm,
      key: conversations.key,
    })
    .from(songFiles)
    .innerJoin(conversations, eq(conversations.id, songFiles.conversationId))
    .where(
      and(
        eq(conversations.bandId, bandId),
        eq(songFiles.kind, 'audio'),
        opts.from ? gte(songFiles.createdAt, opts.from) : undefined,
        opts.to ? lt(songFiles.createdAt, opts.to) : undefined,
      ),
    )
    // Ties broken by id so paging can't repeat or skip a row when several
    // files land in the same millisecond — a bulk import does exactly that.
    .orderBy(desc(songFiles.createdAt), desc(songFiles.id))
    .$dynamic();

  const rows = await (opts.limit != null
    ? query.limit(opts.limit).offset(opts.offset ?? 0)
    : query);

  return rows.map((r) => ({
    ...r,
    title: r.title ?? r.fileName,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** All audio versions for a song, default first, then oldest → newest. */
export async function listAudioVersions(
  conversationId: string,
): Promise<AudioVersion[]> {
  const rows = await db
    .select({
      id: songFiles.id,
      fileName: songFiles.fileName,
      mimeType: songFiles.mimeType,
      sizeBytes: songFiles.sizeBytes,
      songLength: songFiles.songLength,
      isDefault: songFiles.isDefault,
      label: songFiles.label,
      updatedAt: songFiles.updatedAt,
    })
    .from(songFiles)
    .where(
      and(
        eq(songFiles.conversationId, conversationId),
        eq(songFiles.kind, 'audio'),
      ),
    )
    .orderBy(desc(songFiles.isDefault), asc(songFiles.createdAt));
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

/** One specific audio version, ready to serve (scoped to its conversation). */
export async function getAudioVersionTarget(
  conversationId: string,
  versionId: string,
): Promise<SongFileTarget | null> {
  return getVersionTarget(conversationId, versionId, 'audio');
}

/** Metadata for one specific audio version (scoped to its conversation). */
export async function getAudioVersionMeta(
  conversationId: string,
  versionId: string,
): Promise<SongFileMeta | null> {
  const target = await getAudioVersionTarget(conversationId, versionId);
  return target ? toMeta(target) : null;
}

/**
 * Make `versionId` the default audio for its song. Clears the existing
 * default first (so there's never two) then sets the new one, in a single
 * transaction. Returns false if the version doesn't exist for this song.
 */
export async function setDefaultAudioVersion(
  conversationId: string,
  versionId: string,
): Promise<boolean> {
  if (!isUuid(versionId)) return false;
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: songFiles.id })
      .from(songFiles)
      .where(
        and(
          eq(songFiles.id, versionId),
          eq(songFiles.conversationId, conversationId),
          eq(songFiles.kind, 'audio'),
        ),
      )
      .limit(1);
    if (!target) return false;

    await tx
      .update(songFiles)
      .set({ isDefault: false })
      .where(
        and(
          eq(songFiles.conversationId, conversationId),
          eq(songFiles.kind, 'audio'),
          eq(songFiles.isDefault, true),
        ),
      );
    await tx
      .update(songFiles)
      .set({ isDefault: true })
      .where(eq(songFiles.id, versionId));
    return true;
  });
}

/**
 * Set (or clear) an audio version's label. An empty/whitespace label is
 * stored as null. Returns false if the version doesn't exist for this song.
 */
export async function setAudioVersionLabel(
  conversationId: string,
  versionId: string,
  label: string | null,
): Promise<boolean> {
  if (!isUuid(versionId)) return false;
  const trimmed = label?.trim() ? label.trim() : null;
  const [row] = await db
    .update(songFiles)
    .set({ label: trimmed, updatedAt: new Date() })
    .where(
      and(
        eq(songFiles.id, versionId),
        eq(songFiles.conversationId, conversationId),
        eq(songFiles.kind, 'audio'),
      ),
    )
    .returning({ id: songFiles.id });
  return Boolean(row);
}

/**
 * Delete one audio version. If it was the default and other versions
 * remain, the newest remaining version is promoted to default. Returns
 * null if the version doesn't exist for this song, otherwise the id of the
 * new default (or null if none remain).
 */
export async function deleteAudioVersion(
  conversationId: string,
  versionId: string,
): Promise<{ newDefaultId: string | null } | null> {
  if (!isUuid(versionId)) return null;
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: songFiles.id,
        storageKey: songFiles.storageKey,
        isDefault: songFiles.isDefault,
      })
      .from(songFiles)
      .where(
        and(
          eq(songFiles.id, versionId),
          eq(songFiles.conversationId, conversationId),
          eq(songFiles.kind, 'audio'),
        ),
      )
      .limit(1);
    if (!row) return null;

    await tx.delete(songFiles).where(eq(songFiles.id, versionId));

    let newDefaultId: string | null = null;
    if (row.isDefault) {
      const [next] = await tx
        .select({ id: songFiles.id })
        .from(songFiles)
        .where(
          and(
            eq(songFiles.conversationId, conversationId),
            eq(songFiles.kind, 'audio'),
          ),
        )
        .orderBy(desc(songFiles.createdAt))
        .limit(1);
      if (next) {
        await tx
          .update(songFiles)
          .set({ isDefault: true })
          .where(eq(songFiles.id, next.id));
        newDefaultId = next.id;
      }
    }
    return { storageKey: row.storageKey, newDefaultId };
  });

  if (!result) return null;
  if (result.storageKey) await deleteObjects([result.storageKey]);
  return { newDefaultId: result.newDefaultId };
}

export interface SongFileStream {
  body: Readable;
  status: 200 | 206;
  contentLength?: number;
  /** Present for partial responses. */
  contentRange?: string;
}

/**
 * Fetch the bytes from object storage, honoring an HTTP Range header (the
 * store computes the range and returns 206 + Content-Range). Throws on a
 * Range the store can't satisfy — the route maps that to 416.
 *
 * Takes a key rather than a (conversation, version) pair so a caller that has
 * already resolved the row — the serving route, via `SongFileTarget` — doesn't
 * pay for the lookup twice.
 */
export async function streamStoredFile(
  storageKey: string,
  rangeHeader?: string,
): Promise<SongFileStream> {
  const res = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: storageKey,
      Range: rangeHeader,
    }),
  );
  const contentRange = res.ContentRange ?? undefined;
  return {
    body: res.Body as Readable,
    status: contentRange ? 206 : 200,
    contentLength:
      typeof res.ContentLength === 'number' ? res.ContentLength : undefined,
    contentRange,
  };
}

export async function streamSongFile(
  conversationId: string,
  kind: SongFileKind,
  rangeHeader?: string,
): Promise<SongFileStream | null> {
  const target = await getSongFileTarget(conversationId, kind);
  if (!target?.storageKey) return null;
  return streamStoredFile(target.storageKey, rangeHeader);
}

/** Stream one specific audio version (scoped to its conversation). */
export async function streamAudioVersion(
  conversationId: string,
  versionId: string,
  rangeHeader?: string,
): Promise<SongFileStream | null> {
  const target = await getAudioVersionTarget(conversationId, versionId);
  if (!target?.storageKey) return null;
  return streamStoredFile(target.storageKey, rangeHeader);
}

export async function deleteSongFile(
  conversationId: string,
  kind: SongFileKind,
): Promise<void> {
  const row = await getRow(conversationId, kind);
  await db
    .delete(songFiles)
    .where(
      and(
        eq(songFiles.conversationId, conversationId),
        eq(songFiles.kind, kind),
      ),
    );
  if (row?.storageKey) await deleteObjects([row.storageKey]);
}

/** Object keys for one conversation (for cascade cleanup before a DB delete). */
export async function storageKeysForConversation(
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ key: songFiles.storageKey })
    .from(songFiles)
    .where(eq(songFiles.conversationId, conversationId));
  return rows.map((r) => r.key).filter((k): k is string => Boolean(k));
}

/** Object keys for every conversation in a band. */
export async function storageKeysForBand(bandId: string): Promise<string[]> {
  const rows = await db
    .select({ key: songFiles.storageKey })
    .from(songFiles)
    .innerJoin(conversations, eq(conversations.id, songFiles.conversationId))
    .where(eq(conversations.bandId, bandId));
  return rows.map((r) => r.key).filter((k): k is string => Boolean(k));
}

/** Best-effort delete of objects from storage (used after a cascade delete). */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await getS3Client().send(
      new DeleteObjectsCommand({
        Bucket: getBucket(),
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  } catch (err) {
    console.error('[song-files] batch object delete failed', err);
  }
}

// ── Sheet-music versions ─────────────────────────────────────────────
// Mirrors the audio-version model: multiple sheet_music rows per song, one
// flagged `isDefault`, each with an optional `label`. No duration probe.

export interface SheetVersion {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  isDefault: boolean;
  label: string | null;
  updatedAt: string;
}

/**
 * Add a sheet-music version. The first version for a song becomes its default;
 * later ones don't. The check + insert run in one transaction so the default
 * flag stays consistent with the partial unique index.
 */
export async function addSheetVersion(input: {
  conversationId: string;
  body: Readable;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
  label?: string | null;
  driveFileId?: string | null;
}): Promise<SheetVersion> {
  const key = sheetVersionKey(input.conversationId, randomUUID());
  await putObjectStream(key, input.body, input.mimeType, input.sizeBytes);

  const row = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: songFiles.id })
      .from(songFiles)
      .where(
        and(
          eq(songFiles.conversationId, input.conversationId),
          eq(songFiles.kind, 'sheet_music'),
          eq(songFiles.isDefault, true),
        ),
      )
      .limit(1);
    const isDefault = existing.length === 0;

    const [inserted] = await tx
      .insert(songFiles)
      .values({
        conversationId: input.conversationId,
        kind: 'sheet_music',
        storageKey: key,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        songLength: null,
        isDefault,
        label: input.label ?? null,
        driveFileId: input.driveFileId ?? null,
      })
      .returning({
        id: songFiles.id,
        fileName: songFiles.fileName,
        mimeType: songFiles.mimeType,
        sizeBytes: songFiles.sizeBytes,
        isDefault: songFiles.isDefault,
        label: songFiles.label,
        updatedAt: songFiles.updatedAt,
      });
    return inserted!;
  });

  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

/** All sheet-music versions for a song, default first, then oldest → newest. */
export async function listSheetVersions(
  conversationId: string,
): Promise<SheetVersion[]> {
  const rows = await db
    .select({
      id: songFiles.id,
      fileName: songFiles.fileName,
      mimeType: songFiles.mimeType,
      sizeBytes: songFiles.sizeBytes,
      isDefault: songFiles.isDefault,
      label: songFiles.label,
      updatedAt: songFiles.updatedAt,
    })
    .from(songFiles)
    .where(
      and(
        eq(songFiles.conversationId, conversationId),
        eq(songFiles.kind, 'sheet_music'),
      ),
    )
    .orderBy(desc(songFiles.isDefault), asc(songFiles.createdAt));
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

/** Metadata for one specific sheet-music version (scoped to its conversation). */
export async function getSheetVersionTarget(
  conversationId: string,
  versionId: string,
): Promise<SongFileTarget | null> {
  return getVersionTarget(conversationId, versionId, 'sheet_music');
}

export async function getSheetVersionMeta(
  conversationId: string,
  versionId: string,
): Promise<SongFileMeta | null> {
  const target = await getSheetVersionTarget(conversationId, versionId);
  return target ? toMeta(target) : null;
}

/** Make `versionId` the default sheet for its song. */
export async function setDefaultSheetVersion(
  conversationId: string,
  versionId: string,
): Promise<boolean> {
  if (!isUuid(versionId)) return false;
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: songFiles.id })
      .from(songFiles)
      .where(
        and(
          eq(songFiles.id, versionId),
          eq(songFiles.conversationId, conversationId),
          eq(songFiles.kind, 'sheet_music'),
        ),
      )
      .limit(1);
    if (!target) return false;

    await tx
      .update(songFiles)
      .set({ isDefault: false })
      .where(
        and(
          eq(songFiles.conversationId, conversationId),
          eq(songFiles.kind, 'sheet_music'),
          eq(songFiles.isDefault, true),
        ),
      );
    await tx
      .update(songFiles)
      .set({ isDefault: true })
      .where(eq(songFiles.id, versionId));
    return true;
  });
}

/**
 * Overwrite a sheet-music version's file content in place (same storage key,
 * so the default/label/order and any per-user preference are preserved).
 * Updates the row's file name, MIME, size, and updatedAt. Returns the updated
 * version, or null if it doesn't exist for this song.
 */
export async function updateSheetVersionContent(input: {
  conversationId: string;
  versionId: string;
  body: Readable;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
}): Promise<SheetVersion | null> {
  if (!isUuid(input.versionId)) return null;
  const [existing] = await db
    .select({ storageKey: songFiles.storageKey })
    .from(songFiles)
    .where(
      and(
        eq(songFiles.id, input.versionId),
        eq(songFiles.conversationId, input.conversationId),
        eq(songFiles.kind, 'sheet_music'),
      ),
    )
    .limit(1);
  if (!existing?.storageKey) return null;

  await putObjectStream(
    existing.storageKey,
    input.body,
    input.mimeType,
    input.sizeBytes,
  );

  const [row] = await db
    .update(songFiles)
    .set({
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      updatedAt: new Date(),
    })
    .where(eq(songFiles.id, input.versionId))
    .returning({
      id: songFiles.id,
      fileName: songFiles.fileName,
      mimeType: songFiles.mimeType,
      sizeBytes: songFiles.sizeBytes,
      isDefault: songFiles.isDefault,
      label: songFiles.label,
      updatedAt: songFiles.updatedAt,
    });
  return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null;
}

/** Set (or clear) a sheet-music version's label. */
export async function setSheetVersionLabel(
  conversationId: string,
  versionId: string,
  label: string | null,
): Promise<boolean> {
  if (!isUuid(versionId)) return false;
  const trimmed = label?.trim() ? label.trim() : null;
  const [row] = await db
    .update(songFiles)
    .set({ label: trimmed, updatedAt: new Date() })
    .where(
      and(
        eq(songFiles.id, versionId),
        eq(songFiles.conversationId, conversationId),
        eq(songFiles.kind, 'sheet_music'),
      ),
    )
    .returning({ id: songFiles.id });
  return Boolean(row);
}

/**
 * Delete one sheet-music version. If it was the default and others remain, the
 * newest remaining version is promoted. Per-user prefs pointing at it cascade
 * away (FK), so those users fall back to the default.
 */
export async function deleteSheetVersion(
  conversationId: string,
  versionId: string,
): Promise<{ newDefaultId: string | null } | null> {
  if (!isUuid(versionId)) return null;
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: songFiles.id,
        storageKey: songFiles.storageKey,
        isDefault: songFiles.isDefault,
      })
      .from(songFiles)
      .where(
        and(
          eq(songFiles.id, versionId),
          eq(songFiles.conversationId, conversationId),
          eq(songFiles.kind, 'sheet_music'),
        ),
      )
      .limit(1);
    if (!row) return null;

    await tx.delete(songFiles).where(eq(songFiles.id, versionId));

    let newDefaultId: string | null = null;
    if (row.isDefault) {
      const [next] = await tx
        .select({ id: songFiles.id })
        .from(songFiles)
        .where(
          and(
            eq(songFiles.conversationId, conversationId),
            eq(songFiles.kind, 'sheet_music'),
          ),
        )
        .orderBy(desc(songFiles.createdAt))
        .limit(1);
      if (next) {
        await tx
          .update(songFiles)
          .set({ isDefault: true })
          .where(eq(songFiles.id, next.id));
        newDefaultId = next.id;
      }
    }
    return { storageKey: row.storageKey, newDefaultId };
  });

  if (!result) return null;
  if (result.storageKey) await deleteObjects([result.storageKey]);
  return { newDefaultId: result.newDefaultId };
}

// ── Per-user sheet-version preference ────────────────────────────────

/** The user's chosen sheet version for a song, if any (raw, unvalidated). */
export async function getSheetVersionPref(
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ versionId: sheetVersionPrefs.versionId })
    .from(sheetVersionPrefs)
    .where(
      and(
        eq(sheetVersionPrefs.userId, userId),
        eq(sheetVersionPrefs.conversationId, conversationId),
      ),
    )
    .limit(1);
  return row?.versionId ?? null;
}

/** Upsert the user's chosen sheet version for a song. */
export async function setSheetVersionPref(
  userId: string,
  conversationId: string,
  versionId: string,
): Promise<void> {
  await db
    .insert(sheetVersionPrefs)
    .values({ userId, conversationId, versionId })
    .onConflictDoUpdate({
      target: [sheetVersionPrefs.userId, sheetVersionPrefs.conversationId],
      set: { versionId, updatedAt: new Date() },
    });
}

/**
 * Resolve which sheet version the user should see: their preference if it
 * still exists among `versions`, else the default, else the first, else null.
 */
export function resolvePreferredSheetVersionId(
  versions: SheetVersion[],
  prefVersionId: string | null,
): string | null {
  if (versions.length === 0) return null;
  if (prefVersionId && versions.some((v) => v.id === prefVersionId))
    return prefVersionId;
  return (versions.find((v) => v.isDefault) ?? versions[0]!).id;
}
