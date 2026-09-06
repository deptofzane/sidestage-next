import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentDbUser } from '@/lib/current-user';
import { getMembership } from '@/lib/db/bands';
import { getSetlist } from '@/lib/db/setlists';
import { formatDuration, formatSongMeta } from '@/lib/format';
import { PageHeader } from '../../../../PageHeader';
import { SetlistActions } from './SetlistActions';
import { SetlistSongActions } from './SetlistSongActions';
import { SongTitle } from '../../../../SongTitle';

/**
 * View a setlist: its name and songs in order. Server shell — the setlist
 * must exist, belong to this band, and the viewer must be a band member.
 */
export default async function SetlistPage({
  params,
}: {
  params: Promise<{ bandId: string; setlistId: string }>;
}) {
  const { bandId, setlistId } = await params;

  const user = await getCurrentDbUser();
  if (!user) redirect('/login');

  const setlist = await getSetlist(setlistId);
  if (!setlist || setlist.bandId !== bandId) notFound();
  if (!(await getMembership(user.id, bandId))) notFound();

  // Count / duration reflect actual songs, not markers (set breaks etc.).
  const playable = setlist.songs.filter((s) => s.conversationId);
  const songCount = playable.length;
  const totalSeconds = playable.reduce(
    (sum, s) => sum + (s.songLength ?? 0),
    0,
  );
  // Whether every song contributed a known length (else the total is partial).
  const allKnown = playable.every((s) => s.songLength != null);

  // Render rows with manual song numbering so markers aren't numbered.
  const itemRows = setlist.songs.map((s, i) => {
    const songNo = i + 1;
    if (s.conversationId) {
      return (
        <li key={s.id} className="flex items-center gap-3 text-sm">
          <span className="w-5 shrink-0 text-right text-xs text-neutral-400">
            {songNo}
          </span>
          <span className="min-w-0">
            <Link
              href={`/notes/${s.conversationId}/practice`}
              className="hover:underline"
            >
              <SongTitle title={s.name} originalArtist={s.originalArtist} />
            </Link>
            {s.songLength ? (
              <span className="text-neutral-400">
                {` - ${formatDuration(s.songLength)}`}
              </span>
            ) : null}
            {formatSongMeta(s.bpm, s.key) && (
              <span className="text-neutral-400">
                {` · ${formatSongMeta(s.bpm, s.key)}`}
              </span>
            )}
          </span>
          <span className="ml-auto shrink-0 self-center">
            <SetlistSongActions
              conversationId={s.conversationId}
              name={s.name}
            />
          </span>
        </li>
      );
    }
    return (
      <li key={s.id} className="flex items-center gap-3 py-3">
        <span className="w-5 shrink-0 text-right text-xs text-neutral-400">
          {songNo}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide minor-text-theme-colors">
          {s.name}
        </span>
      </li>
    );
  });

  return (
    <main className="main-container">
      <PageHeader defaultHref={`/bands/${bandId}`} defaultHrefName="Band" />
      <span className="flex justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="title-text">{setlist.name}</h1>
          <p className="text-sm minor-text-theme-colors pb-4">
            {songCount} {songCount === 1 ? 'song' : 'songs'}
            {songCount > 0 && (
              <>
                {' · '}
                {allKnown ? '' : '~'}
                {formatDuration(totalSeconds)}
              </>
            )}
          </p>
        </div>
        {/* Rendered even for an empty setlist: it now carries "Edit setlist",
            which is exactly what an empty one needs. The playback and offline
            actions inside it gate themselves on there being songs. */}
        <SetlistActions
          bandId={bandId}
          setlistId={setlistId}
          name={setlist.name}
          songs={setlist.songs}
        />
      </span>

      {setlist.songs.length === 0 ? (
        <p className="rounded-md border border-line px-1 py-6 text-center text-sm minor-text-theme-colors">
          This setlist has no songs.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 rounded-lg border border-line px-1 py-3">
          {itemRows}
        </ul>
      )}
    </main>
  );
}
