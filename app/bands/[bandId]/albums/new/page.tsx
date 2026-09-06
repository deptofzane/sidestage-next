import { notFound, redirect } from 'next/navigation';
import { getCurrentDbUser } from '@/lib/current-user';
import { getMembership } from '@/lib/db/bands';
import { listBandConversations } from '@/lib/db/conversations';
import { PageHeader } from '../../../../PageHeader';
import { AlbumEditor } from '../AlbumEditor';

/**
 * New album. Server shell — membership guard, then the band's songs as the
 * pool the editor picks from.
 */
export default async function NewAlbumPage({
  params,
}: {
  params: Promise<{ bandId: string }>;
}) {
  const { bandId } = await params;

  const user = await getCurrentDbUser();
  if (!user) redirect('/login');
  if (!(await getMembership(user.id, bandId))) notFound();

  // Archived songs are excluded, matching the setlist editor and what the API
  // will accept — offering one the save would silently drop is worse than not
  // offering it.
  const songPool = (await listBandConversations(bandId))
    .filter((c) => !c.archived)
    .map((c) => ({
      conversationId: c.id,
      name: c.audioFileName ?? 'Untitled audio',
      originalArtist: c.originalArtist,
    }));

  return (
    <main className="main-container">
      <PageHeader
        defaultHref={`/bands/${bandId}/audio?tab=songs`}
        defaultHrefName="Songs"
      />
      <AlbumEditor
        bandId={bandId}
        albumId={null}
        initialName=""
        initialTracks={[]}
        songPool={songPool}
      />
    </main>
  );
}
