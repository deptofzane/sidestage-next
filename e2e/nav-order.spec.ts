import { test, expect, type Page } from '@playwright/test';

/**
 * The left-handed nav setting (Settings › Appearance).
 *
 * Three things this can silently get wrong, so each gets an assertion: the
 * drawer arriving from the wrong edge, the bar not actually mirroring, and
 * the preference applying only after hydration — which is a visible flip on
 * every page load rather than a wrong pixel.
 */

/** Open the ☰ drawer and wait for the slide to settle. */
async function openDrawer(page: Page) {
  await page.getByRole('button', { name: /^Menu/ }).click();
  const drawer = page.locator('#app-nav-menu');
  await expect(drawer).toBeVisible();
  await page.waitForTimeout(350);
  return drawer;
}

/** Which edge the drawer is flush against. */
async function drawerEdge(page: Page): Promise<'left' | 'right'> {
  const box = (await page.locator('#app-nav-menu').boundingBox())!;
  const width = page.viewportSize()!.width;
  return box.x < 1 ? 'left' : box.x + box.width >= width - 1 ? 'right' : 'left';
}

async function setReversed(page: Page, on: boolean) {
  await page.goto('/settings?tab=appearance');
  const toggle = page
    .getByRole('button', { name: /^(On|Off)$/ })
    .and(page.locator('[aria-pressed]'));
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
}

test.afterEach(async ({ page }) => {
  // The preference is per-device localStorage, so it would leak into the
  // specs that run after this file.
  await page.evaluate(() => {
    try {
      localStorage.removeItem('navReversed');
    } catch {}
  });
});

/** The close button's horizontal centre, relative to the drawer's own box. */
async function closeButtonSide(page: Page): Promise<'left' | 'right'> {
  const drawer = (await page.locator('#app-nav-menu').boundingBox())!;
  const close = (await page
    .getByRole('menuitem', { name: 'Close menu' })
    .boundingBox())!;
  return close.x + close.width / 2 < drawer.x + drawer.width / 2
    ? 'left'
    : 'right';
}

test('by default the drawer comes from the right', async ({ page }) => {
  await page.goto('/home');
  await openDrawer(page);
  expect(await drawerEdge(page)).toBe('right');
  expect(await closeButtonSide(page)).toBe('right');
});

/**
 * Menu item labels in the order they appear on screen, top to bottom.
 *
 * Reads text content rather than computing accessible names, so a row that
 * wraps extra text — Band carries the current band and a chevron — comes back
 * concatenated. Fine for asking about order, which is all this is for.
 */
async function itemOrder(page: Page): Promise<string[]> {
  const items = page.getByRole('menuitem');
  const boxes = await items.evaluateAll((els) =>
    els.map((el) => ({
      label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
      top: el.getBoundingClientRect().top,
    })),
  );
  return boxes.sort((a, b) => a.top - b.top).map((b) => b.label);
}

test('the phone drawer is two groups, in order', async ({ page }) => {
  await page.goto('/home');
  await openDrawer(page);
  const order = await itemOrder(page);

  // Top group, reading down. The email is role="presentation", so it is not
  // a menuitem and does not appear here — its position is checked below.
  expect(order.slice(0, 5)).toEqual([
    'Sign out',
    'Settings',
    'File management',
    'About',
    'Help',
  ]);

  // Bottom group, anchored to the bottom, with Close last of all.
  expect(order.slice(5)).toEqual([
    expect.stringMatching(/^Band/),
    'Home',
    'History',
    'Open Conversations',
    'Chat',
    'Events',
    'Close menu',
  ]);
});

test('the band panel keeps Back on top and its choices at the bottom', async ({
  page,
}) => {
  await page.goto('/home');
  const drawer = await openDrawer(page);
  await page.getByRole('menuitem', { name: /^Band/ }).click();

  const back = (await page
    .getByRole('menuitem', { name: 'Back' })
    .boundingBox())!;
  const viewBands = (await page
    .getByRole('menuitem', { name: 'View bands' })
    .boundingBox())!;
  const box = (await drawer.boundingBox())!;

  // Back caps the top; the choices are pushed to the far end.
  expect(back.y - box.y).toBeLessThan(80);
  expect(viewBands.y - (back.y + back.height)).toBeGreaterThan(40);
  expect(viewBands.y).toBeGreaterThan(box.y + box.height / 2);
});

test('the account email heads the top group', async ({ page }) => {
  await page.goto('/home');
  await openDrawer(page);
  const email = (await page
    .locator('#app-nav-menu [role="presentation"]')
    .first()
    .boundingBox())!;
  const signOut = (await page
    .getByRole('menuitem', { name: 'Sign out' })
    .boundingBox())!;
  expect(email.y).toBeLessThan(signOut.y);
});

test('the two groups are pushed to opposite edges', async ({ page }) => {
  await page.goto('/home');
  await openDrawer(page);
  const drawer = (await page.locator('#app-nav-menu').boundingBox())!;
  const help = (await page
    .getByRole('menuitem', { name: 'Help' })
    .boundingBox())!;
  const band = (await page
    .getByRole('menuitem', { name: /^Band/ })
    .boundingBox())!;
  // A real gap between the groups is the whole point of anchoring them.
  expect(band.y - (help.y + help.height)).toBeGreaterThan(40);
  // ...and the bottom group reaches the bottom.
  expect(drawer.y + drawer.height - band.y).toBeLessThan(drawer.height / 2);
});

test('on a phone Close sits in the bottom corner', async ({ page }) => {
  await page.goto('/home');
  await openDrawer(page);
  const drawer = (await page.locator('#app-nav-menu').boundingBox())!;
  const close = (await page
    .getByRole('menuitem', { name: 'Close menu' })
    .boundingBox())!;
  // Below every menu item, and against the drawer's own bottom padding.
  const signOut = (await page
    .getByRole('menuitem', { name: 'Sign out' })
    .boundingBox())!;
  expect(close.y).toBeGreaterThan(signOut.y);
  expect(drawer.y + drawer.height - (close.y + close.height)).toBeLessThan(20);
});

test('the close button shuts the drawer', async ({ page }) => {
  await page.goto('/home');
  await openDrawer(page);
  await page.getByRole('menuitem', { name: 'Close menu' }).click();
  await expect(page.locator('#app-nav-menu')).toHaveCount(0);
});

test('turning it on mirrors the bar and moves the drawer left', async ({
  page,
}) => {
  await setReversed(page, true);
  await page.goto('/home');

  // The bar mirrors: ☰ ends up left of the logo.
  const menuBox = (await page
    .getByRole('button', { name: /^Menu/ })
    .boundingBox())!;
  const logoBox = (await page
    .locator('#app-nav a[href="/home"]')
    .first()
    .boundingBox())!;
  expect(menuBox.x).toBeLessThan(logoBox.x);

  // ...and so do the tabs inside it: a mirror, not just a swapped ☰.
  const tabs = page.locator('#app-nav .nav-tabs');
  const overview = (await tabs
    .getByRole('link', { name: 'Overview' })
    .boundingBox())!;
  const calendar = (await tabs
    .getByRole('link', { name: 'Calendar' })
    .boundingBox())!;
  expect(overview.x).toBeGreaterThan(calendar.x);

  await openDrawer(page);
  expect(await drawerEdge(page)).toBe('left');
  expect(await closeButtonSide(page)).toBe('left');
});

test('it applies before paint, not after hydration', async ({ page }) => {
  await setReversed(page, true);
  // Read the attribute as early as the document exists: if this only arrived
  // with React, the bar would visibly flip on every load.
  await page.goto('/home', { waitUntil: 'commit' });
  await expect(page.locator('html')).toHaveAttribute('data-nav-reversed', '');
});

test.describe('desktop is left alone', () => {
  test.use({
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false,
  });

  test('Close sits at the top right', async ({ page }) => {
    await page.goto('/home');
    await openDrawer(page);
    const drawer = (await page.locator('#app-nav-menu').boundingBox())!;
    const close = (await page
      .getByRole('menuitem', { name: 'Close menu' })
      .boundingBox())!;
    const band = (await page
      .getByRole('menuitem', { name: /^Band/ })
      .boundingBox())!;
    // Above the first menu item, and against the top-right corner.
    expect(close.y).toBeLessThan(band.y);
    expect(close.y - drawer.y).toBeLessThan(20);
    expect(drawer.x + drawer.width - (close.x + close.width)).toBeLessThan(20);
  });

  test('Sign out stays last, below Help', async ({ page }) => {
    await page.goto('/home');
    await openDrawer(page);
    // The phone's copy is display:none here, so this also proves only one of
    // the two is ever in the accessibility tree.
    const signOut = (await page
      .getByRole('menuitem', { name: 'Sign out' })
      .boundingBox())!;
    const help = (await page
      .getByRole('menuitem', { name: 'Help' })
      .boundingBox())!;
    expect(signOut.y).toBeGreaterThan(help.y);
  });

  test('the drawer still comes from the right when reversed', async ({
    page,
  }) => {
    await setReversed(page, true);
    await page.goto('/home');
    await openDrawer(page);
    expect(await drawerEdge(page)).toBe('right');
  });
});
