import { expect, test } from './fixtures';

test('application cards launch apps and the library is the main heading', async ({ page, context }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Application library/, level: 2 })).toHaveCount(0);
  await context.route('**/grocy/', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Grocy application</h1>' }));
  const card = page.locator('.app-card').filter({ has: page.getByRole('heading', { name: 'Grocy', exact: true }) });
  await card.getByRole('button', { name: 'Pin Grocy', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Unpin Grocy', exact: true })).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  await card.getByRole('button', { name: 'Details for Grocy' }).click();
  await expect(page.getByRole('dialog', { name: 'Grocy', exact: true })).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  for (const layout of ['Grid view', 'List view']) {
    await page.getByRole('button', { name: layout, exact: true }).click();
    const opened = page.waitForEvent('popup');
    await card.click({ position: { x: 18, y: 18 } });
    const popup = await opened;
    await expect(popup).toHaveURL(/\/grocy\/$/);
    await popup.close();
  }
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const keyboardOpen = page.waitForEvent('popup');
  await card.getByRole('link', { name: 'Open Grocy', exact: true }).focus();
  await page.keyboard.press('Enter');
  const keyboardPopup = await keyboardOpen;
  await expect(keyboardPopup).toHaveURL(/\/grocy\/$/);
  await keyboardPopup.close();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('clickable-cards.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Appearance settings' }).click();
  await page.getByRole('checkbox', { name: 'Open apps in a new tab' }).uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await card.click({ position: { x: 18, y: 18 } });
  await expect(page).toHaveURL(/\/grocy\/$/);
});

test('recently opened is removed and app launches no longer record history', async ({ page, context }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const { user } = await (await page.request.get('/api/portal/auth/me')).json();
  const key = `ssportal.${user.id}.visits`;
  const previous = JSON.stringify([{ id: 'grocy', at: '2026-01-01T00:00:00.000Z' }]);
  await page.evaluate(({ key, previous }) => localStorage.setItem(key, previous), { key, previous });
  await page.reload();
  await page.getByRole('button', { name: 'Pin Grocy', exact: true }).click();
  await context.route('**/grocy/', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Grocy test destination</title>' }));
  for (const name of ['Applications', 'Favorites', 'Services']) {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name: /Recently opened/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear history', exact: true })).toHaveCount(0);
    const opened = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open Grocy', exact: true }).click();
    const popup = await opened;
    await expect(popup).toHaveURL(/\/grocy\/$/);
    await popup.close();
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(previous);
  }
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await expect(page.locator('.app-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('applications-no-recent.png'), fullPage: true, animations: 'disabled' });
});

test('metrics are hidden only on the Applications tab', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
  const summary = page.getByRole('region', { name: 'Workspace summary' });
  await expect(summary).toHaveCount(0);
  await expect(page.locator('.app-card')).toHaveCount(3);
  for (const name of ['Favorites', 'Services']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(summary).toBeVisible();
  }
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await expect(summary).toHaveCount(0);
  await expect(page.locator('.app-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('applications-no-metrics.png'), fullPage: true, animations: 'disabled' });
});

test('renders real app assets and same-host paths without page overflow or JavaScript errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
  await expect(page.locator('.app-card')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Open Grocy', exact: true })).toHaveAttribute('href', '/grocy/');
  await expect(page.getByRole('link', { name: 'Open webtrees', exact: true })).toHaveAttribute('href', '/webtrees/');
  await expect(page.getByRole('link', { name: 'Open ssAcademy', exact: true })).toHaveAttribute('href', '/ssacademy/');
  const academyIcon = page.locator('.app-card').filter({ has: page.getByRole('heading', { name: 'ssAcademy', exact: true }) }).locator('.app-icon img');
  await expect(academyIcon).toHaveAttribute('src', '/icons/ssacademy.png');
  await expect(academyIcon).toHaveJSProperty('naturalWidth', 256);
  await expect(academyIcon).toHaveJSProperty('naturalHeight', 256);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(academyIcon).toBeVisible();
  await page.getByRole('button', { name: 'Details for ssAcademy', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'ssAcademy', exact: true }).locator('.app-icon img')).toHaveAttribute('src', '/icons/ssacademy.png');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('link', { name: 'Services', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'ssAcademy' }).locator('.app-icon img')).toHaveJSProperty('naturalWidth', 256);
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true, animations: 'disabled' });
});

test('search, category filters, favorites, and layout persist correctly', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-card')).toHaveCount(3);
  await page.getByRole('searchbox', { name: 'Search applications' }).fill('groceries');
  await expect(page.locator('.app-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Grocy', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Filter by category').selectOption('Genealogy');
  await expect(page.getByRole('heading', { name: 'webtrees', exact: true })).toBeVisible();
  await page.getByLabel('Filter by category').selectOption('all');
  await page.getByRole('button', { name: 'Pin Grocy', exact: true }).click();
  await page.getByRole('link', { name: 'Favorites' }).click();
  await expect(page.locator('.app-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'List view' }).click();
  await page.reload();
  await expect(page.locator('.application-grid')).toHaveClass(/list-layout/);
  await expect(page.getByRole('button', { name: 'Unpin Grocy', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unpin Grocy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No favorites yet' })).toBeVisible();
});

test('all seven themes support light and dark modes, persist, and follow system changes', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Appearance settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  const themes = [
    ['Midnight blue', 'midnight'], ['Maize and blue', 'maize-blue'], ['Royal purple', 'royal-purple'],
    ['Gold', 'gold'], ['Green', 'green'], ['Pink', 'pink'], ['Black', 'black'],
  ];
  for (const [name, id] of themes) {
    await dialog.getByRole('button', { name: `${name} theme`, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    for (const mode of ['Light', 'Dark']) {
      await dialog.getByRole('button', { name: mode, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme-mode', mode.toLowerCase());
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.screenshot({ path: testInfo.outputPath('appearance-dark.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await page.screenshot({ path: testInfo.outputPath('dashboard-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Appearance settings' }).click();
  await dialog.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Appearance settings' })).toBeFocused();
});

test('details and service view expose separate paths and respect launch preferences', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Details for Grocy' }).click();
  const details = page.getByRole('dialog', { name: 'Grocy', exact: true });
  await expect(details.getByText('/grocy/api/', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Appearance settings' }).click();
  await page.getByRole('checkbox', { name: 'Open apps in a new tab' }).uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Grocy', exact: true })).not.toHaveAttribute('target', '_blank');
  await page.getByRole('link', { name: 'Services', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText('/api/portal/', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('failed API requests show a recoverable error and malformed preferences do not crash the app', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ssportal.preferences', '{invalid json'));
  await page.route('**/api/portal/apps', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Unable to refresh application status');
  await page.unroute('**/api/portal/apps');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.app-card')).toHaveCount(3);
  await expect(page.getByRole('alert')).toHaveCount(0);
});