import { expect, test } from './fixtures';

test('renders real app assets and same-host paths without page overflow or JavaScript errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your applications.' })).toBeVisible();
  await expect(page.locator('.app-card')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Open Grocy', exact: true })).toHaveAttribute('href', '/grocy/');
  await expect(page.getByRole('link', { name: 'Open webtrees', exact: true })).toHaveAttribute('href', '/webtrees/');
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
});

test('search, category filters, favorites, and layout persist correctly', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-card')).toHaveCount(2);
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
  await expect(page.locator('.app-card')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});