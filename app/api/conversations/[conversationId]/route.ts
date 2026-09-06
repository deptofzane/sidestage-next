import { NextResponse } from 'next/server';
import { requireConversationMember, requireUser } from '@/lib/api-guard';
import {
  ConversationConflictError,
  deleteConversation,
  getConversationMembership,
  moveConversation,
  renameConversation,
  setConversationArchived,
  setConversationClosed,
  setConversationMeta,
} from '@/lib/db/conversations';
import { getConversationActivity } from '@/lib/db/activity';
import { loadNotes } from '@/lib/db/notes';
import { getMembership, listMembers } from '@/lib/db/bands';
import { notify } from '@/lib/db/notifications';

/**
 * GET    /api/conversations/[conversationId]
 *   → { conversation, closed, notes (threaded), activity, members, myRole }
 *
 * PATCH  /api/conversations/[conversationId]
 *   Body may include any of:
 *   { closed?, name?, bandId?, archived?, originalArtist?, bpm?, key? }
 *   — open/close, rename, move to another band you belong to, archive, or set
 *   the optional tempo / key (send null to clear either).
 *
 * DELETE /api/conversations/[conversationId]
 *   → delete the song (cascades notes, mentions, activity, files).
 *
 * All require membership in the conversation's owning band.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const guard = await requireConversationMember(conversationId);
  if (guard instanceof NextResponse) return guard;
  const { user, membership } = guard;

  const [notes, activity, members] = await Promise.all([
    loadNotes(conversationId, user.id),
    getConversationActivity(conversationId),
    listMembers(membership.conversation.bandId),
  ]);

  return NextResponse.json({
    conversation: membership.conversation,
    closed: membership.conversation.closed,
    notes,
    activity,
    members,
    myRole: membership.role,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const guard = await requireConversationMember(conversationId);
  if (guard instanceof NextResponse) return guard;
  const { user, membership } = guard;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return NextResponse.json({ error: 'bad_body' }, { status: 400 });

  let conversation = membership.conversation;
  // What the edit actually touched, so the notification can name it rather
  // than saying "updated a song". Also decides *whether* to notify: an empty
  // list means nothing changed, and a save that changed nothing shouldn't
  // reach the band's feed.
  const changed: string[] = [];
  // The name before any rename, captured before `conversation` is reassigned
  // below — afterwards only the new name is in scope.
  const previousName = conversation.audioFileName;

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name || name.length > 255)
      return NextResponse.json(
        { error: 'bad_name', message: 'Name must be 1–255 characters.' },
        { status: 400 },
      );
    // Compare first: renaming to the same string is a no-op, and used to
    // notify the whole band anyway.
    if (name !== (conversation.audioFileName ?? null)) {
      conversation = await renameConversation(conversationId, name);
      changed.push('name');
    }
  }

  if (typeof body.bandId === 'string' && body.bandId !== conversation.bandId) {
    // You can only move a song to a band you belong to.
    if (!(await getMembership(user.id, body.bandId)))
      return NextResponse.json(
        { error: 'forbidden', message: 'You’re not a member of that band.' },
        { status: 403 },
      );
    try {
      conversation = await moveConversation(conversationId, body.bandId);
      changed.push('band');
    } catch (err) {
      if (err instanceof ConversationConflictError)
        return NextResponse.json(
          { error: 'conflict', message: err.message },
          { status: 409 },
        );
      throw err;
    }
  }

  if (typeof body.closed === 'boolean') {
    await setConversationClosed(conversationId, user.id, body.closed);
    conversation = { ...conversation, closed: body.closed };
  }

  if (typeof body.archived === 'boolean') {
    // Same no-op guard as the rename: only report an actual change, and say
    // which direction it went so the wording can differ.
    if (body.archived !== conversation.archived) {
      conversation = await setConversationArchived(
        conversationId,
        body.archived,
      );
      changed.push(body.archived ? 'archived' : 'unarchived');
    }
  }

  // Optional song metadata (original artist / tempo / key). Present-but-unchanged
  // is a no-op; send null to clear any of them.
  const meta: {
    originalArtist?: string | null;
    bpm?: number | null;
    key?: string | null;
  } = {};
  if ('originalArtist' in body) {
    const raw = body.originalArtist;
    let originalArtist: string | null;
    if (raw === null || raw === '') originalArtist = null;
    else if (typeof raw === 'string') {
      const t = raw.trim();
      originalArtist = t ? t.slice(0, 120) : null;
    } else
      return NextResponse.json(
        {
          error: 'bad_original_artist',
          message: 'Original artist must be text.',
        },
        { status: 400 },
      );
    if (originalArtist !== (conversation.originalArtist ?? null))
      meta.originalArtist = originalArtist;
  }
  if ('bpm' in body) {
    const raw = body.bpm;
    let bpm: number | null;
    if (raw === null || raw === '') bpm = null;
    else if (
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= 1 &&
      raw <= 400
    )
      bpm = raw;
    else
      return NextResponse.json(
        {
          error: 'bad_bpm',
          message: 'BPM must be a whole number from 1 to 400.',
        },
        { status: 400 },
      );
    if (bpm !== (conversation.bpm ?? null)) meta.bpm = bpm;
  }
  if ('key' in body) {
    const raw = body.key;
    let key: string | null;
    if (raw === null || raw === '') key = null;
    else if (typeof raw === 'string') {
      const t = raw.trim();
      key = t ? t.slice(0, 24) : null;
    } else
      return NextResponse.json(
        { error: 'bad_key', message: 'Key must be text.' },
        { status: 400 },
      );
    if (key !== (conversation.key ?? null)) meta.key = key;
  }
  if (
    meta.originalArtist !== undefined ||
    meta.bpm !== undefined ||
    meta.key !== undefined
  ) {
    conversation = await setConversationMeta(conversationId, meta);
    // `meta` only carries keys whose value actually differs, so its keys are
    // exactly the fields that changed.
    changed.push(...Object.keys(meta));
  }

  if (changed.length > 0) {
    await notify({
      bandId: conversation.bandId,
      actorId: user.id,
      kind: 'song-updated',
      subjectType: 'conversation',
      subjectId: conversationId,
      subjectLabel: conversation.audioFileName,
      changedFields: changed,
      // Only meaningful on a rename; harmless otherwise, and the phrasing
      // helper reads it only when 'name' is in the list.
      previousLabel: changed.includes('name') ? previousName : null,
    });
  }

  return NextResponse.json({ conversation });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { conversationId } = await params;

  if (!(await getConversationMembership(user.id, conversationId)))
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  await deleteConversation(conversationId);
  return new NextResponse(null, { status: 204 });
}
