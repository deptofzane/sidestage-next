/**
 * A song's title, with the artist it's originally by underneath when it's a
 * cover.
 *
 * Emits two block lines, each truncating on its own, rather than one inline
 * run. That matters for the callers: a wrapper carrying `truncate` sets
 * `white-space: nowrap`, which a nested line would inherit and be clipped by
 * instead of wrapping — so wrappers pass their `min-w-0` and drop their own
 * `truncate`, and each line ellipsises independently. Font weight and size
 * still come from the wrapper, so a row keeps whatever emphasis it had.
 *
 * `meta` (tempo / key) joins the credit rather than claiming a third line,
 * which is what keeps a setlist row two lines tall whatever it carries.
 *
 * The words "Originally by" are deliberate and not shortened to a bare dash.
 * This field is who the song is *originally* by, and "Title / Pink Floyd"
 * would read as who is performing it, which is the opposite.
 */
export function SongTitle({
  title,
  originalArtist,
  meta,
}: {
  title: string;
  originalArtist?: string | null;
  /** Tempo / key, appended to the credit line. See `formatSongMeta`. */
  meta?: string | null;
}) {
  const second = [
    originalArtist ? `Originally by ${originalArtist}` : null,
    meta,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <span className="block truncate">{title}</span>
      {second && (
        <span className="block truncate text-xs font-normal minor-text-theme-colors">
          {second}
        </span>
      )}
    </>
  );
}
