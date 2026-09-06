import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../../app/bands/[bandId]/bandDetailShared';
import type { BandUpload } from '../../lib/db/song-files';
import {
  isPlayableNotification,
  isSetlistNotification,
  isUploadNotification,
  tracksForNotification,
  type PlayableNotification,
} from '../../app/home/notificationTracks';
import {
  uploadTrack,
  uploadsQueue,
} from '../../app/bands/[bandId]/audio/uploadDays';

/**
 * ISO for a *local* wall-clock time. Upload days are the viewer's local days
 * (see `dayKey`), so fixtures written as UTC instants would straddle midnight
 * differently depending on where the test runs.
 */
function localIso(year: number, month: number, day: number, hour: number) {
  return new Date(year, month - 1, day, hour).toISOString();
}

/** A band song, with audio unless `audioStoredName` is nulled out. */
function song(id: string, createdAt: string, audio = true): Conversation {
  return {
    id,
    audioFileName: `${id}.mp3`,
    closed: false,
    archived: false,
    originalArtist: null,
    bpm: null,
    key: null,
    createdAt,
    updatedAt: createdAt,
    songLength: 120,
    audioStoredName: audio ? `${id}-stored.mp3` : null,
    audioMimeType: audio ? 'audio/mpeg' : null,
    audioVersionId: audio ? `${id}-ver` : null,
    hasSheetMusic: false,
  };
}

/** One uploaded audio file. */
function upload(over: Partial<BandUpload> & { fileId: string }): BandUpload {
  return {
    conversationId: `conv-${over.fileId}`,
    title: 'A Song',
    fileName: `${over.fileId}.wav`,
    label: null,
    mimeType: 'audio/wav',
    songLength: 100,
    isDefault: true,
    createdAt: localIso(2026, 8, 4, 12),
    originalArtist: null,
    bpm: null,
    key: null,
    ...over,
  };
}

function notification(
  over: Partial<PlayableNotification> = {},
): PlayableNotification {
  return {
    kind: 'audio-added',
    subjectId: null,
    subjectLabel: null,
    bandName: 'The Band',
    createdAt: localIso(2026, 8, 4, 12),
    ...over,
  };
}

test('notification tracks: uploads and new setlists are playable, nothing else', () => {
  assert.equal(isUploadNotification(notification()), true);
  assert.equal(
    isSetlistNotification(
      notification({ kind: 'setlist-created', subjectId: 's1' }),
    ),
    true,
  );
  // A setlist notification with no subject names nothing to fetch.
  assert.equal(
    isSetlistNotification(notification({ kind: 'setlist-created' })),
    false,
  );
  for (const kind of ['song-created', 'chat-message', 'poll-created']) {
    assert.equal(isPlayableNotification(notification({ kind })), false, kind);
  }
});

test('notification tracks: a named upload resolves to exactly its song', () => {
  const conversations = [
    song('a', localIso(2026, 8, 4, 11)),
    song('b', localIso(2026, 8, 4, 11)),
  ];
  const tracks = tracksForNotification(
    notification({ subjectId: 'b', subjectLabel: 'b.mp3' }),
    conversations,
  );
  assert.deepEqual(
    tracks.map((t) => t.id),
    ['b'],
  );
  const [track] = tracks;
  assert.ok(track);
  // Version-explicit, so the cached bytes can never be another take's.
  assert.equal(
    track.src,
    '/api/conversations/b/files/audio?version=b-ver&name=b-stored.mp3',
  );
  assert.equal(track.subtitle, 'The Band');
});

test('notification tracks: a rollup names no song, so this resolves nothing', () => {
  // Rollups cover a day and include new versions, so they resolve from the
  // band's uploads instead — see `uploadsQueue` below.
  assert.deepEqual(
    tracksForNotification(notification(), [
      song('a', localIso(2026, 8, 4, 11)),
    ]),
    [],
  );
});

test('notification tracks: a named upload with nothing behind it plays nothing', () => {
  // Song deleted since the notification.
  assert.deepEqual(
    tracksForNotification(notification({ subjectId: 'gone' }), [
      song('still-here', localIso(2026, 8, 4, 11)),
    ]),
    [],
  );
  // Song still there, audio removed.
  assert.deepEqual(
    tracksForNotification(notification({ subjectId: 'silent' }), [
      song('silent', localIso(2026, 8, 4, 11), false),
    ]),
    [],
  );
});

test('uploads queue: a day plays in upload order, versions included', () => {
  const uploads = [
    upload({ fileId: 'x', createdAt: localIso(2026, 8, 4, 9) }),
    // A second take of the *same* song, later the same day: both play.
    upload({
      fileId: 'x-v2',
      conversationId: 'conv-x',
      isDefault: false,
      createdAt: localIso(2026, 8, 4, 17),
    }),
    upload({ fileId: 'y', createdAt: localIso(2026, 8, 4, 13) }),
  ];
  assert.deepEqual(
    uploadsQueue(uploads, '2026-08-04').map((t) => t.fileName),
    ['x.wav', 'y.wav', 'x-v2.wav'],
  );
});

test('uploads queue: scoped to its own local day', () => {
  const uploads = [
    upload({ fileId: 'day-before', createdAt: localIso(2026, 8, 3, 23) }),
    upload({ fileId: 'first-thing', createdAt: localIso(2026, 8, 4, 0) }),
    upload({ fileId: 'last-thing', createdAt: localIso(2026, 8, 4, 23) }),
    upload({ fileId: 'day-after', createdAt: localIso(2026, 8, 5, 0) }),
  ];
  assert.deepEqual(
    uploadsQueue(uploads, '2026-08-04').map((t) => t.fileName),
    ['first-thing.wav', 'last-thing.wav'],
  );
});

test('uploads queue: the song titles the track, the file names it', () => {
  const track = uploadTrack(
    upload({
      fileId: 'f1',
      conversationId: 'c1',
      title: 'Cascade',
      fileName: 'cascade-take-2.wav',
      label: 'Take 2',
      songLength: 244,
    }),
  );
  assert.equal(track.title, 'Cascade');
  // The label wins over the file name — it's what the version switcher shows.
  assert.equal(track.subtitle, 'Take 2');
  // The id stays the conversation's, so the queue's row actions still resolve.
  assert.equal(track.id, 'c1');
  // …while the src names the exact version, so two takes don't collide.
  assert.equal(
    track.src,
    '/api/conversations/c1/files/audio?version=f1&name=cascade-take-2.wav',
  );
  assert.equal(track.durationSec, 244);
});

test('uploads queue: with no label the file name stands in', () => {
  const track = uploadTrack(
    upload({ fileId: 'f2', fileName: 'rehearsal.mp3', label: null }),
  );
  assert.equal(track.subtitle, 'rehearsal.mp3');
});
