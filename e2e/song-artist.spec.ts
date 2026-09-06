import '../scripts/load-env';
import { test, expect } from '@playwright/test';
import { readSeed } from './fixtures';
import { db } from '../lib/db';
import { conversations } from '../lib/db/schema';
import { findOrCreateConversation } from '../lib/db/conversations';
import { eq } from 'drizzle-orm';

/**
 * A cover's original artist follows its title wherever the title is shown.
 *
 * The plumbing is type-enforced — `SetlistItem.originalArtist` is required, so
 * a mapping that drops it won't compile — but nothing stops a surface from
 * receiving the field and never rendering it, which is what these check.
 */
const seed = readSeed();
const ARTIST = 'Pink Floyd';

let coverId = '';

test.beforeAll(async () => {
  await db
    .update(conversations)
    .set({ originalArtist: ARTIST })
    .where(eq(conversations.id, seed.songId));
  // A song NOT in the setlist, so the Add-songs pool has something to show.
  const cover = await findOrCreateConversation(
    seed.bandId,
    'e2e-artist-probe',
    'E2E Cover Song',
  );
  coverId = cover.id;
  await db
    .update(conversations)
    .set({ originalArtist: 'The Beatles' })
    .where(eq(conversations.id, coverId));
});

test.afterAll(async () => {
  await db
    .update(conversations)
    .set({ originalArtist: null })
    .where(eq(conversations.id, seed.songId));
});

test('view setlist shows the artist after the title', async ({ page }) => {
  await page.goto(`/bands/${seed.bandId}/setlists/${seed.setlistId}`);
  await expect(page.getByText(`Originally by ${ARTIST}`).first()).toBeVisible();
});

test('edit setlist and the add-songs modal show it too', async ({ page }) => {
  await page.goto(`/bands/${seed.bandId}/setlists/${seed.setlistId}/edit`);
  await expect(page.getByText(`Originally by ${ARTIST}`).first()).toBeVisible();

  await page.getByRole('button', { name: 'Add songs' }).first().click();
  await expect(
    page.getByText('Originally by The Beatles').first(),
  ).toBeVisible();
});
