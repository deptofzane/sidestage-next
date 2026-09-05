import { test, expect } from '@playwright/test';
import { readSeed } from './fixtures';
import { Readable } from 'node:stream';
import { findOrCreateConversation } from '../lib/db/conversations';
import {
  addAudioVersion,
  addSheetVersion,
  listBandFiles,
} from '../lib/db/song-files';

const seed = readSeed();
const SONG = 'E2E Files Song';
const AUDIO = 'e2e-files-take.mp3';
const SHEET = 'e2e-files-chart.pdf';

/**
 * Its own song, with its own audio and chart: the page lists everything the
 * band has, and later specs still need the seeded song's files, so nothing
 * here touches them.
 */
test.beforeAll(async () => {
  const song = await findOrCreateConversation(seed.bandId, 'e2e-files', SONG);
  const existing = (await listBandFiles(seed.bandId)).filter(
    (f) => f.songName === SONG,
  );
  if (!existing.some((f) => f.fileName === AUDIO)) {
    const bytes = Buffer.alloc(4 * 1024, 7);
    await addAudioVersion({
      conversationId: song.id,
      body: Readable.from(bytes),
      sizeBytes: bytes.length,
      fileName: AUDIO,
      mimeType: 'audio/mpeg',
      driveFileId: 'e2e-audio-files-page',
    });
  }
  if (!existing.some((f) => f.fileName === SHEET)) {
    const bytes = Buffer.from('%PDF-1.4\n% e2e files page\n');
    await addSheetVersion({
      conversationId: song.id,
      body: Readable.from(bytes),
      sizeBytes: bytes.length,
      fileName: SHEET,
      mimeType: 'application/pdf',
      driveFileId: 'e2e-sheet-files-page',
    });
  }
});

const filesUrl = () => `/bands/${seed.bandId}/files`;

test('the page lists a band’s files with their size and song', async ({
  page,
}) => {
  await page.goto(filesUrl());

  await expect(
    page.getByRole('heading', { name: 'File management' }),
  ).toBeVisible();
  // The meter reads against the cap, not just a raw number.
  await expect(page.getByText(/of 10 GB used/)).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: AUDIO });
  await expect(row).toBeVisible();
  await expect(row).toContainText(SONG);
  await expect(row).toContainText('4.0 KB');
  // Nothing here is archived, so every row says so.
  await expect(row).toContainText('Active');
});

test('the tabs separate audio from sheet music', async ({ page }) => {
  await page.goto(filesUrl());

  await page.getByRole('tab', { name: 'Audio files' }).click();
  await expect(page.getByText(AUDIO)).toBeVisible();
  await expect(page.getByText(SHEET)).toHaveCount(0);

  await page.getByRole('tab', { name: 'Sheet music' }).click();
  await expect(page.getByText(SHEET)).toBeVisible();
  await expect(page.getByText(AUDIO)).toHaveCount(0);

  await page.getByRole('tab', { name: 'All' }).click();
  await expect(page.getByText(AUDIO)).toBeVisible();
  await expect(page.getByText(SHEET)).toBeVisible();
});

test('search narrows the list', async ({ page }) => {
  await page.goto(filesUrl());

  await page.getByPlaceholder('Search by file, song, or label').fill(AUDIO);
  await expect(page.getByText(AUDIO)).toBeVisible();
  await expect(page.getByText(SHEET)).toHaveCount(0);

  await page
    .getByPlaceholder('Search by file, song, or label')
    .fill('nothing matches this');
  await expect(page.getByText('No files match that search.')).toBeVisible();
});

test('sorting by size reverses on a second click', async ({ page }) => {
  await page.goto(filesUrl());

  const sizes = async () =>
    page.locator('tbody tr td:nth-last-child(3)').allInnerTexts();

  await page.getByRole('button', { name: 'Size' }).click();
  const ascending = await sizes();
  await page.getByRole('button', { name: 'Size' }).click();
  const descending = await sizes();

  expect(descending).toEqual([...ascending].reverse());
});

/*
 * Note the direction: on a phone File management sits *below* Settings, in
 * the drawer's hand-ordered top group (see nav-order.spec.ts). Desktop still
 * lists it above, following `navLinks` order — this suite runs at a phone
 * viewport, so it asserts the phone's answer.
 */
test('the ☰ menu offers File management, below Settings', async ({ page }) => {
  await page.goto(`/bands/${seed.bandId}`);
  await page.getByRole('button', { name: 'Menu' }).click();

  const files = page.getByRole('menuitem', { name: 'File management' });
  const settings = page.getByRole('menuitem', { name: 'Settings' });
  await expect(files).toBeVisible();

  const filesBox = await files.boundingBox();
  const settingsBox = await settings.boundingBox();
  expect(filesBox!.y).toBeGreaterThan(settingsBox!.y);

  await files.click();
  await expect(
    page.getByRole('heading', { name: 'File management' }),
  ).toBeVisible();
});

test('deleting warns that a song is losing its only audio', async ({
  page,
}) => {
  await page.goto(filesUrl());

  const row = page.getByRole('row').filter({ hasText: AUDIO });
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(AUDIO);
  await expect(dialog).toContainText('This is the song’s only audio file.');

  // Unchecking leaves the row on the list — and empties the batch, so there
  // is nothing left to delete.
  await dialog.getByRole('checkbox', { name: `Delete ${AUDIO}` }).uncheck();
  await expect(dialog.getByText(AUDIO)).toBeVisible();
  await expect(
    dialog.getByText('This is the song’s only audio file.'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Delete 0 files$/ }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await expect(page.getByText(AUDIO)).toBeVisible();
});

/*
 * Runs last, and takes the chart rather than the audio: `beforeAll` puts it
 * back for the next run, and removing it warns about nothing, so what's being
 * tested is the delete itself.
 */
test('a confirmed delete removes the file and updates the total', async ({
  page,
}) => {
  await page.goto(filesUrl());

  const counter = page.getByText(/^\d+ files?$/);
  const before = Number((await counter.innerText()).split(' ')[0]);
  await page
    .getByRole('row')
    .filter({ hasText: SHEET })
    .getByRole('checkbox')
    .check();

  /*
   * The dialog asks the server what's worth warning about as it opens, and
   * the card is vertically centred — so the answer landing resizes it and
   * moves the buttons. Wait for that round trip before aiming at one. (The
   * test above doesn't need this: waiting for its warning text is the same
   * wait by another name.)
   */
  const preflight = page.waitForResponse((r) =>
    r.url().includes(`/api/bands/${seed.bandId}/files/preflight`),
  );
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await preflight;

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(SHEET);
  await dialog.getByRole('button', { name: /^Delete 1 file$/ }).click();

  await expect(page.getByText('Deleted 1 file.')).toBeVisible();
  await expect(page.getByText(SHEET)).toHaveCount(0);
  /*
   * The meter is redrawn from the band's fresh total. Counted in files, not
   * bytes: a 26-byte chart doesn't move a total that reads in KB.
   */
  await expect(counter).toHaveText(`${before - 1} files`);

  await page.reload();
  await expect(page.getByText(SHEET)).toHaveCount(0);
});
