import { notFound, redirect } from 'next/navigation';
import { getCurrentDbUser } from '@/lib/current-user';
import { getMembership } from '@/lib/db/bands';
import { getAlbum } from '@/lib/db/albums';
import { listBandConversations } from '@/lib/db/conversations';
import { PageHeader } from '../../../../../PageHeader';
import { AlbumEditor, type AlbumEditorTrack } from '../../AlbumEditor';

/**
 * Edit an album: its name, its running order, and which version each track
 * plays. Server shell — the album must exist, belong to this band, and the
 * viewer must be a member.
 */
export default async function EditAlbumPage({
  params,
}: {
  params: Promise<{ bandId: string; albumId: string }>;
}) {
  const { bandId, albumId } = await params;

  const user = await getCurrentDbUser();
  if (!user) redirect('/login');

  const album = await getAlbum(albumId);
  if (!album || album.bandId !== bandId) notFound();
  if (!(await getMembership(user.id, bandId))) notFound();

  const songPool = (await listBandConversations(bandId))
    .filter((c) => !c.archived)
    .map((c) => ({
      conversationId: c.id,
      name: c.audioFileName ?? 'Untitled audio',
      originalArtist: c.originalArtist,
    }));

  // The editor's row id is the album_tracks id, so a song appearing twice
  // stays two independently editable rows through a reorder.
  const initialTracks: AlbumEditorTrack[] = album.tracks.map((t) => ({
    id: t.id,
    conversationId: t.conversationId,
    name: t.name,
    originalArtist: t.originalArtist,
    // A lost pin has no id left to send back; the editor shows it as deleted
    // and saving as-is drops the pin, which is the honest outcome.
    audioVersionId: t.state === 'pinned' ? t.audioVersionId : null,
    pinnedLabel: t.pinnedLabel,
    pinnedFileName: t.pinnedFileName,
    lost:
      t.state === 'lost' || (t.state === 'unplayable' && !!t.pinnedFileName),
  }));

  return (
    <main className="main-container">
      <PageHeader
        defaultHref={`/bands/${bandId}/albums/${albumId}`}
        defaultHrefName="Album"
      />
      <AlbumEditor
        bandId={bandId}
        albumId={albumId}
        initialName={album.name}
        initialTracks={initialTracks}
        songPool={songPool}
      />
    </main>
  );
}
