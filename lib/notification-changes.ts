/**
 * Turning "what changed" into words.
 *
 * Shared by the in-app feed (app/home/NotificationList.tsx) and Web Push
 * (lib/push.ts) so the two can't drift into describing the same row
 * differently — the phrasing is the whole point of the feature, and two copies
 * would diverge the first time either is reworded.
 *
 * Pure, so the rules can be tested directly rather than through a rendered
 * feed. Every function takes the stored field *tokens* (see `changed_fields`
 * in schema.ts) and returns a fragment; the caller supplies the actor and the
 * subject around it.
 */

/** Display names for the fields an event edit can touch. */
const EVENT_FIELD_LABELS: Record<string, string> = {
  title: 'title',
  eventType: 'type',
  date: 'date',
  endDate: 'end date',
  time: 'time',
  endTime: 'end time',
  location: 'location',
  details: 'details',
  notes: 'notes',
  setlistId: 'setlist',
  venueId: 'venue',
};

/**
 * Display names for a song's *metadata* fields.
 *
 * Renames, moves and archiving are absent on purpose: they're actions, not
 * field edits, and each gets its own sentence — see `describeSongChange`.
 */
const SONG_FIELD_LABELS: Record<string, string> = {
  originalArtist: 'original artist',
  bpm: 'tempo',
  key: 'key',
};

/**
 * "the date", "the date and time", "the date, time and 2 more".
 *
 * Capped rather than listed in full: an event edit routinely touches four or
 * five fields, and a notification that reads them all out stops being
 * scannable — which is what it's for.
 */
function fieldList(labels: string[]): string {
  if (labels.length === 1) return `the ${labels[0]}`;
  if (labels.length === 2) return `the ${labels[0]} and ${labels[1]}`;
  return `the ${labels[0]}, ${labels[1]} and ${labels.length - 2} more`;
}

const labelsFor = (fields: string[], map: Record<string, string>) =>
  fields.map((f) => map[f]).filter((l): l is string => Boolean(l));

/**
 * An event edit, as a sentence fragment following the actor's name — or null
 * when there's nothing specific to say and the caller should fall back to its
 * generic wording (an older row, or fields we have no label for).
 */
export function describeEventChange(
  changedFields: string[] | null | undefined,
  subject: string,
): string | null {
  if (!changedFields || changedFields.length === 0) return null;
  const labels = labelsFor(changedFields, EVENT_FIELD_LABELS);
  if (labels.length === 0) return null;
  return `updated ${fieldList(labels)} on ${subject}`;
}

/**
 * A song edit, as a sentence fragment following the actor's name.
 *
 * One headline in priority order — moved, then archived, then renamed, then
 * metadata — with a count of anything else. `EditSongClient` saves every field
 * in one PATCH, so a rename arriving alongside a tempo change is ordinary, and
 * listing several actions in one sentence reads worse than naming the biggest.
 */
export function describeSongChange(
  changedFields: string[] | null | undefined,
  subject: string,
  opts: { previousLabel?: string | null; bandName?: string | null } = {},
): string | null {
  if (!changedFields || changedFields.length === 0) return null;
  const has = (f: string) => changedFields.includes(f);

  // Everything the headline doesn't cover, so the sentence can admit to it.
  const rest = (headlineFields: string[]) =>
    changedFields.filter((f) => !headlineFields.includes(f)).length;
  const tail = (n: number) =>
    n === 0 ? '' : `, and ${n} more change${n === 1 ? '' : 's'}`;

  if (has('band')) {
    return opts.bandName
      ? `moved ${subject} to ${opts.bandName}${tail(rest(['band']))}`
      : `moved ${subject} to another band${tail(rest(['band']))}`;
  }
  if (has('archived')) return `archived ${subject}${tail(rest(['archived']))}`;
  if (has('unarchived'))
    return `unarchived ${subject}${tail(rest(['unarchived']))}`;
  if (has('name')) {
    // The old name is what makes a rename legible — without it the sentence
    // can only name the result, which tells a reader nothing about what moved.
    return opts.previousLabel
      ? `renamed ${opts.previousLabel} to ${subject}${tail(rest(['name']))}`
      : `renamed a song to ${subject}${tail(rest(['name']))}`;
  }

  const labels = labelsFor(changedFields, SONG_FIELD_LABELS);
  if (labels.length === 0) return null;
  return `updated ${fieldList(labels)} on ${subject}`;
}
