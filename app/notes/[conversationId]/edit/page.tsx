import { notFound, redirect } from 'next/navigation';
import { getCurrentDbUser } from '@/lib/current-user';
import { listMyBands } from '@/lib/db/bands';
import { getConversationMembership } from '@/lib/db/conversations';
import { listAudioVersions, listSheetVersions } from '@/lib/db/song-files';
import { EditSongClient } from './EditSongClient';

/**
 * Edit-song page. Server shell — checks band membership, then hands the
 * conversation, the user's bands (move targets), and any sheet-music
 * metadata to the client editor.
 */
export default async function EditSongPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  const user = await getCurrentDbUser();
  if (!user) redirect('/login');

  const membership = await getConversationMembership(user.id, conversationId);
  if (!membership) notFound();
  const conversation = membership.conversation;

  const [bands, sheetVersions, audioVersions] = await Promise.all([
    listMyBands(user.id),
    listSheetVersions(conversationId),
    listAudioVersions(conversationId),
  ]);

  return (
    <main className="main-container pt-2">
      <EditSongClient
        conversationId={conversationId}
        apiKey={process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? ''}
        initialName={conversation.audioFileName ?? ''}
        initialBandId={conversation.bandId}
        initialArchived={conversation.archived}
        initialOriginalArtist={conversation.originalArtist}
        initialBpm={conversation.bpm}
        initialKey={conversation.key}
        bands={bands.map((b) => ({ id: b.id, name: b.name }))}
        audioVersions={audioVersions}
        sheetVersions={sheetVersions}
      />
    </main>
  );
}
