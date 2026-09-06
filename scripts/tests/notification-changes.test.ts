import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEventChange,
  describeSongChange,
} from '../../lib/notification-changes';

// The fragments below are what a reader actually sees after the actor's name,
// so they're asserted verbatim rather than by shape.

test('events: one field is named', () => {
  assert.equal(
    describeEventChange(['date'], 'Spring Rehearsal'),
    'updated the date on Spring Rehearsal',
  );
});

test('events: two fields are joined with "and"', () => {
  assert.equal(
    describeEventChange(['date', 'time'], 'Spring Rehearsal'),
    'updated the date and time on Spring Rehearsal',
  );
});

test('events: three or more are capped with a count', () => {
  assert.equal(
    describeEventChange(['date', 'time', 'location', 'notes'], 'Loft Show'),
    'updated the date, time and 2 more on Loft Show',
  );
});

test('events: ids read as the thing, not the column', () => {
  assert.equal(
    describeEventChange(['venueId'], 'Loft Show'),
    'updated the venue on Loft Show',
  );
  assert.equal(
    describeEventChange(['setlistId'], 'Loft Show'),
    'updated the setlist on Loft Show',
  );
  assert.equal(
    describeEventChange(['eventType'], 'Loft Show'),
    'updated the type on Loft Show',
  );
});

test('events: nothing to say falls back to the caller', () => {
  assert.equal(describeEventChange(null, 'X'), null, 'older row');
  assert.equal(describeEventChange([], 'X'), null, 'empty list');
  assert.equal(describeEventChange(['mystery'], 'X'), null, 'unknown field');
});

test('songs: metadata fields are named', () => {
  assert.equal(
    describeSongChange(['bpm'], 'Wildfire'),
    'updated the tempo on Wildfire',
  );
  assert.equal(
    describeSongChange(['bpm', 'key'], 'Wildfire'),
    'updated the tempo and key on Wildfire',
  );
  assert.equal(
    describeSongChange(['originalArtist'], 'Wildfire'),
    'updated the original artist on Wildfire',
  );
});

test('songs: a rename names what it was called before', () => {
  assert.equal(
    describeSongChange(['name'], 'Wildfire', { previousLabel: 'Blue Room' }),
    'renamed Blue Room to Wildfire',
  );
});

test('songs: a rename without the old name still reads', () => {
  assert.equal(
    describeSongChange(['name'], 'Wildfire'),
    'renamed a song to Wildfire',
  );
});

test('songs: a move names the destination band', () => {
  assert.equal(
    describeSongChange(['band'], 'Wildfire', { bandName: 'The Rooftops' }),
    'moved Wildfire to The Rooftops',
  );
  assert.equal(
    describeSongChange(['band'], 'Wildfire'),
    'moved Wildfire to another band',
  );
});

test('songs: archive and unarchive are distinct', () => {
  assert.equal(
    describeSongChange(['archived'], 'Wildfire'),
    'archived Wildfire',
  );
  assert.equal(
    describeSongChange(['unarchived'], 'Wildfire'),
    'unarchived Wildfire',
  );
});

test('songs: one headline wins, the rest are counted', () => {
  // EditSongClient saves everything in one PATCH, so combinations are normal.
  assert.equal(
    describeSongChange(['name', 'bpm'], 'Wildfire', {
      previousLabel: 'Blue Room',
    }),
    'renamed Blue Room to Wildfire, and 1 more change',
  );
  assert.equal(
    describeSongChange(['name', 'bpm', 'key'], 'Wildfire', {
      previousLabel: 'Blue Room',
    }),
    'renamed Blue Room to Wildfire, and 2 more changes',
  );
});

test('songs: priority is move > archive > rename', () => {
  assert.equal(
    describeSongChange(['name', 'archived', 'band'], 'Wildfire', {
      bandName: 'The Rooftops',
      previousLabel: 'Blue Room',
    }),
    'moved Wildfire to The Rooftops, and 2 more changes',
  );
});

test('songs: nothing to say falls back to the caller', () => {
  assert.equal(describeSongChange(null, 'X'), null);
  assert.equal(describeSongChange([], 'X'), null);
  assert.equal(
    describeSongChange(['closed'], 'X'),
    null,
    'not a reported field',
  );
});
