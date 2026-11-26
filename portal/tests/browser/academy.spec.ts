import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test as portalTest, expect } from './fixtures';
import { buildApp } from '../../../portal_apps/ssAcademy/server/app.mjs';
import { createPortalClient } from '../../../portal_apps/ssAcademy/server/portal-client.mjs';
import { createStore } from '../../../portal_apps/ssAcademy/server/store.mjs';
import { createMemberSession } from '../helpers.mjs';

const exportData = {
  format: 'ssAcademy-collections', version: 1,
  rewards: { LOLLIPOP: { whole: 3, fragments: 2 }, TOYS_1: { whole: 1, fragments: 0 } },
  pokemons: ['PIKACHU', 'BULBASAUR'],
};

const test = portalTest.extend<{ academy: { origin: string; store: ReturnType<typeof createStore> } }>({
  academy: [async ({ portal, context }, use) => {
    const store = createStore();
    const server = await buildApp({ store, portal: createPortalClient({ origin: portal.origin }) });
    try {
      const address = new URL(await server.listen({ host: '127.0.0.1', port: 0 }));
      address.hostname = 'localhost';
      await context.route((url) => url.pathname.startsWith('/ssacademy/'), async (route) => {
        const path = new URL(route.request().url());
        const response = await route.fetch({ url: new URL(path.pathname + path.search, address).href });
        await route.fulfill({ response });
      });
      await use({ origin: address.origin, store });
    } finally { await server.close(); }
  }, { auto: true }],
});

async function importThroughViewer(page: Page, source: string) {
  await page.getByRole('button', { name: 'Import data', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import collection data' });
  await dialog.getByLabel('Source label').fill(source);
  await dialog.getByLabel('Export JSON').fill(JSON.stringify(exportData));
  await dialog.getByRole('button', { name: 'Import data', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('ssAcademy appearance matches every portal palette and synchronizes modes and preferences', async ({ page, context, portal }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => localStorage.setItem('ssportal.preferences', JSON.stringify({
    theme: 'green', mode: 'system', newTab: false, autoRefresh: false, view: 'list',
  })));
  await page.goto('/ssacademy/');
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await expect(dialog.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const portalPage = await context.newPage();
  await portalPage.goto(portal.origin);
  const palette = (target: Page) => target.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['paper', 'surface', 'raised', 'ink', 'muted', 'line', 'accent', 'field', 'on-accent', 'danger', 'warning', 'positive', 'shadow']
      .map((name) => style.getPropertyValue(`--${name}`).trim());
  });
  for (const mode of ['Light', 'Dark']) {
    await dialog.getByRole('button', { name: mode, exact: true }).click();
    for (const name of ['Midnight blue', 'Maize and blue', 'Royal purple', 'Gold', 'Green', 'Pink', 'Black']) {
      const button = dialog.getByRole('button', { name: `${name} theme`, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      const theme = await button.getAttribute('data-theme');
      await expect(portalPage.locator('html')).toHaveAttribute('data-theme', theme!);
      await expect(portalPage.locator('html')).toHaveAttribute('data-theme-mode', mode.toLowerCase());
      expect(await palette(page)).toEqual(await palette(portalPage));
    }
  }
  await dialog.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Appearance settings', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  await dialog.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ssportal.preferences')!))).toEqual({
    theme: 'green', mode: 'system', newTab: false, autoRefresh: false, view: 'list',
  });
  await portalPage.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  await portalPage.getByRole('button', { name: 'Pink theme', exact: true }).click();
  await portalPage.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Pink theme', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await portalPage.close();
});

test('ssAcademy reports unavailable preference storage while applying the chosen appearance', async ({ page }) => {
  await page.goto('/ssacademy/');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await dialog.getByRole('button', { name: 'Royal purple theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'royal-purple');
  await expect(dialog.getByRole('alert')).toContainText('could not be saved');
  await dialog.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'royal-purple');
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
});

test('ssAcademy imports JSON and displays normalized reward and animation records', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/ssacademy/');
  await expect(page.locator('.brand-mark')).toHaveAttribute('src', '/icons/ssacademy.png');
  await expect(page.locator('.brand-mark')).toHaveJSProperty('naturalWidth', 256);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icons/ssacademy.png');
  await expect(page.getByRole('heading', { name: 'Collection exports.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No collection exports' })).toBeVisible();
  await importThroughViewer(page, 'Math tablet');
  await expect(page.getByRole('status')).toContainText('Collection data imported');
  await importThroughViewer(page, 'Math tablet');
  await expect(page.getByRole('status')).toContainText('already stored');
  await expect(page.locator('#imports-body tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'View Math tablet', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: 'Math tablet', exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('table', { name: 'Reward balances' }).getByRole('row').filter({ hasText: 'Lollipop' }).getByRole('cell')).toHaveText(['Lollipop', '1', '3', '2']);
  await expect(detail.getByRole('list', { name: 'Collected animations' }).getByRole('listitem')).toHaveCount(2);
  await detail.getByRole('searchbox', { name: 'Search animations' }).fill('pika');
  await expect(detail.getByRole('listitem')).toHaveCount(1);
  await expect(detail.getByRole('listitem')).toContainText('PIKACHU');
  await page.screenshot({ path: testInfo.outputPath('academy-details.png'), fullPage: true, animations: 'disabled' });
  await detail.getByRole('button', { name: 'Done', exact: true }).click();
  await importThroughViewer(page, 'Reading tablet');
  await page.getByRole('searchbox', { name: 'Search imports' }).fill('Math');
  await expect(page.locator('#imports-body tr')).toHaveCount(1);
  await expect(page.locator('#imports-body')).toContainText('Math tablet');
  await page.getByRole('searchbox', { name: 'Search imports' }).fill('');
  await page.getByLabel('Filter by source').selectOption('Reading tablet');
  await expect(page.locator('#imports-body')).toContainText('Reading tablet');
  await page.getByLabel('Filter by source').selectOption('');
  await expect(page.locator('#imports-body tr')).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('academy-collections.png'), fullPage: true, animations: 'disabled' });
  await page.evaluate(() => localStorage.setItem('ssportal.preferences', JSON.stringify({ theme: 'black', mode: 'dark' })));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(page.locator('#imports-body tr')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('academy-dark.png'), fullPage: true, animations: 'disabled' });
});

test('ssAcademy fingerprint apps require admin approval, stay upload-only, and can be revoked', async ({ page, request, academy }, testInfo) => {
  const fingerprintToken = randomBytes(32).toString('hex');
  const enrollment = { student: 'Test administrator', fingerprintToken };
  const registered = await request.post(`${academy.origin}/ssacademy/api/devices/register`, { data: enrollment });
  expect(registered.status()).toBe(202);
  const device = (await registered.json()).device;
  expect(device.status).toBe('pending');
  const headers = { authorization: `Bearer ${fingerprintToken}` };
  expect((await request.post(`${academy.origin}/ssacademy/api/imports`, { headers, data: { source: 'Before approval', data: exportData } })).status()).toBe(401);
  await page.goto('/ssacademy/#tokens');
  await expect(page.getByRole('button', { name: 'Create token', exact: true })).toHaveCount(0);
  await expect(page.locator('#tokens-body')).toContainText(device.fingerprint);
  await expect(page.locator('#tokens-body [data-status]')).toHaveText('pending');
  await page.screenshot({ path: testInfo.outputPath('academy-app-approval.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: `Approve Test administrator (${device.fingerprint})`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Approve app?', exact: true }).getByRole('button', { name: 'Approve app', exact: true }).click();
  await expect(page.locator('#tokens-body [data-status]')).toHaveText('approved');
  expect((await (await request.post(`${academy.origin}/ssacademy/api/devices/status`, { data: enrollment })).json()).device.status).toBe('approved');
  const uploaded = await request.post(`${academy.origin}/ssacademy/api/imports`, { headers, data: { source: 'Uploaded via API', data: exportData } });
  expect(uploaded.status()).toBe(201);
  const id = (await uploaded.json()).import.id;
  expect((await request.get(`${academy.origin}/ssacademy/api/imports`, { headers })).status()).toBe(403);
  expect((await request.delete(`${academy.origin}/ssacademy/api/imports/${id}`, { headers })).status()).toBe(403);
  academy.store.importData('different-owner', { source: 'Private other user', data: exportData });
  await page.getByRole('link', { name: 'Collections', exact: true }).click();
  await expect(page.locator('#imports-body tr')).toHaveCount(1);
  await expect(page.locator('#imports-body')).not.toContainText('Private other user');
  await page.getByRole('button', { name: 'View Uploaded via API', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: 'Uploaded via API', exact: true });
  await detail.getByRole('button', { name: 'Delete import', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete imported data?' }).getByRole('button', { name: 'Delete import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No collection exports' })).toBeVisible();
  await page.getByRole('link', { name: 'Sync Tokens', exact: true }).click();
  await expect(page.locator('#tokens-body')).toContainText('Test administrator');
  await page.screenshot({ path: testInfo.outputPath('academy-tokens.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: `Revoke Test administrator (${device.fingerprint})`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Revoke app access?' }).getByRole('button', { name: 'Revoke app', exact: true }).click();
  await expect(page.locator('#tokens-body [data-status]')).toHaveText('revoked');
  expect((await request.post(`${academy.origin}/ssacademy/api/imports`, { headers, data: { source: 'Rejected', data: exportData } })).status()).toBe(401);
  expect((await (await request.post(`${academy.origin}/ssacademy/api/devices/register`, { data: enrollment })).json()).device.status).toBe('revoked');
  await page.getByRole('button', { name: `Delete Test administrator (${device.fingerprint})`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete app registration?' }).getByRole('button', { name: 'Delete registration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No app registrations' })).toBeVisible();
});

test('ssAcademy approves accountless students and keeps their uploads isolated', async ({ page, request, portal, academy }, testInfo) => {
  const student = 'New <b>member</b>';
  const fingerprintToken = randomBytes(32).toString('hex');
  for (const name of [student, 'Test administrator']) {
    const registered = await request.post(`${academy.origin}/ssacademy/api/devices/register`, { data: { student: name, fingerprintToken: name === student ? fingerprintToken : randomBytes(32).toString('hex') } });
    expect(registered.status()).toBe(202);
  }
  await page.goto('/ssacademy/#tokens');
  await expect(page.locator('#tokens-body tr')).toHaveCount(2);
  const pending = page.locator('#tokens-body tr').filter({ hasText: student });
  await expect(pending).toContainText('Portal account not required');
  await expect(pending.locator('[data-approve]')).toBeEnabled();
  await expect(page.locator('#tokens-body b')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('academy-app-accounts.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('searchbox', { name: 'Search app students' }).fill('New');
  await expect(page.locator('#tokens-body tr')).toHaveCount(1);
  expect(portal.store.findUserByName(student)).toBeNull();
  await pending.locator('[data-approve]').click();
  const dialog = page.getByRole('dialog', { name: 'Approve app?', exact: true });
  await expect(dialog.locator('b')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Approve app', exact: true }).click();
  await expect(page.locator('#tokens-body [data-status]')).toHaveText('approved');
  await page.getByLabel('Filter app status').selectOption('pending');
  await expect(page.getByRole('heading', { name: 'No matching apps' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search app students' }).fill('');
  await expect(page.locator('#tokens-body tr')).toHaveCount(1);
  await expect(page.locator('#tokens-body')).toContainText('Test administrator');
  await page.getByLabel('Filter app status').selectOption('approved');
  await expect(page.locator('#tokens-body')).toContainText(student);
  await page.getByLabel('Filter app status').selectOption('');
  await expect(page.locator('#tokens-body tr')).toHaveCount(2);
  const headers = { authorization: `Bearer ${fingerprintToken}` };
  const upload = await request.post(`${academy.origin}/ssacademy/api/imports`, { headers, data: { source: 'Independent student tablet', data: exportData } });
  expect(upload.status()).toBe(201);
  const id = (await upload.json()).import.id;
  const downloaded = await request.get(`${academy.origin}/ssacademy/api/imports/${id}`, { headers });
  expect(downloaded.status()).toBe(200);
  expect((await downloaded.json()).import.ownerName).toBe(student);
  expect((await request.get(`${academy.origin}/ssacademy/api/imports`, { headers })).status()).toBe(403);
  const otherToken = randomBytes(32).toString('hex');
  const otherRegistration = await request.post(`${academy.origin}/ssacademy/api/devices/register`, { data: { student, fingerprintToken: otherToken } });
  const otherId = (await otherRegistration.json()).device.id;
  expect((await page.request.patch(`${academy.origin}/ssacademy/api/tokens/${otherId}`, { headers: { origin: portal.origin }, data: { status: 'approved' } })).status()).toBe(200);
  expect((await request.get(`${academy.origin}/ssacademy/api/imports/${id}`, { headers: { authorization: `Bearer ${otherToken}` } })).status()).toBe(404);
  await page.getByRole('link', { name: 'Collections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No collection exports' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'All users', exact: true }).check();
  await expect(page.locator('#imports-body')).toContainText(student);
  await expect(page.locator('#imports-body b')).toHaveCount(0);
  await page.getByRole('button', { name: 'View Independent student tablet', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Independent student tablet', exact: true })).toBeVisible();
  expect(portal.store.findUserByName(student)).toBeNull();
});

test('ssAcademy rejects invalid imports and reads local files as JSON data, never multipart uploads', async ({ page }) => {
  await page.goto('/ssacademy/');
  await page.getByRole('button', { name: 'Import data', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import collection data' });
  await dialog.getByLabel('Source label').fill('Tablet <b>label</b>');
  await dialog.getByLabel('Export JSON').fill('{invalid json');
  await dialog.getByRole('button', { name: 'Import data', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('valid ssAcademy');
  await page.locator('#json-file').setInputFiles({ name: 'collections.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exportData)) });
  await expect(dialog.getByLabel('Export JSON')).toHaveValue(JSON.stringify(exportData));
  const request = page.waitForRequest((request) => request.url().endsWith('/ssacademy/api/imports') && request.method() === 'POST');
  await dialog.getByRole('button', { name: 'Import data', exact: true }).click();
  const upload = await request;
  expect(upload.headers()['content-type']).toBe('application/json');
  expect(Object.keys(upload.postDataJSON()).sort()).toEqual(['data', 'source']);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#imports-body')).toContainText('Tablet <b>label</b>');
  await expect(page.locator('#imports-body b')).toHaveCount(0);
});

test('ssAcademy administrators edit another owner values without losing import identity', async ({ page, academy }, testInfo) => {
  const original = academy.store.importData('learner-owner', { source: 'Student tablet', data: exportData }, 'Learner').import;
  await page.goto('/ssacademy/');
  await expect(page.getByRole('heading', { name: 'No collection exports' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'All users', exact: true }).check();
  await expect(page.locator('#imports-body')).toContainText('Learner');
  await page.getByRole('button', { name: 'View Student tablet', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: 'Student tablet', exact: true });
  await expect(detail.getByRole('button', { name: 'Delete import', exact: true })).not.toBeVisible();
  await detail.getByRole('button', { name: 'Edit values', exact: true }).click();
  await detail.getByRole('spinbutton', { name: 'Lollipop whole', exact: true }).fill('12');
  await detail.getByRole('spinbutton', { name: 'Lollipop fragments', exact: true }).fill('1');
  await detail.getByRole('textbox', { name: 'Animation IDs', exact: true }).fill('PIKACHU\nMEGA_CHARIZARD_X\nFUTURE__ANIMATION_');
  await page.screenshot({ path: testInfo.outputPath('academy-edit.png'), fullPage: true, animations: 'disabled' });
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(detail.getByRole('status')).toContainText('values saved');
  await expect(detail.locator('#detail-revision')).toHaveText('2');
  await expect(detail.getByRole('table', { name: 'Reward balances' }).getByRole('row').filter({ hasText: 'Lollipop' }).getByRole('cell')).toHaveText(['Lollipop', '1', '12', '1']);
  await expect(detail.locator('#animations-list')).toContainText('MEGA_CHARIZARD_X');
  await expect(detail.locator('#animations-list')).toContainText('FUTURE__ANIMATION_');
  const restored = (await (await page.request.get(`${academy.origin}/ssacademy/api/imports/${original.id}`)).json()).import;
  expect(restored.importedSha256).toBe(original.sha256);
  expect(restored.ownerId).toBe('learner-owner');
  expect(academy.store.importData('learner-owner', { source: 'Student tablet', data: exportData }).import.revision).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('ssAcademy edit forms reject stale revisions instead of overwriting newer values', async ({ page, portal, academy }) => {
  await page.goto('/ssacademy/');
  await importThroughViewer(page, 'Tablet');
  await page.getByRole('button', { name: 'View Tablet', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: 'Tablet', exact: true });
  await detail.getByRole('button', { name: 'Edit values', exact: true }).click();
  await detail.getByRole('spinbutton', { name: 'Lollipop whole', exact: true }).fill('12');
  const listing = await (await page.request.get(`${academy.origin}/ssacademy/api/imports`)).json();
  const id = listing.imports[0].id;
  const changed = { ...exportData, rewards: { LOLLIPOP: { whole: 20, fragments: 0 } } };
  const updated = await page.request.patch(`${academy.origin}/ssacademy/api/imports/${id}`, { headers: { origin: portal.origin }, data: { revision: 1, data: changed } });
  expect(updated.status()).toBe(200);
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('collection changed');
  const stored = await (await page.request.get(`${academy.origin}/ssacademy/api/imports/${id}`)).json();
  expect(stored.import.rewards[0].whole).toBe(20);
});

test('ssAcademy members cannot edit values or view other owners', async ({ page, context, portal, academy }) => {
  const administrator = portal.store.findUserByName('Test administrator')!;
  const member = createMemberSession(portal.store, administrator.id, 'Member');
  const record = academy.store.importData(member.userId, { source: 'Member tablet', data: exportData }, 'Member').import;
  await context.clearCookies();
  await context.addCookies([{ name: 'ssportal_session', value: member.token, url: portal.origin, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto('/ssacademy/');
  await expect(page.getByRole('checkbox', { name: 'All users', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sync Tokens', exact: true })).toHaveCount(0);
  expect((await page.request.get(`${academy.origin}/ssacademy/api/tokens`)).status()).toBe(403);
  await page.getByRole('button', { name: 'View Member tablet', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Edit values', exact: true })).toHaveCount(0);
  const rejected = await page.request.patch(`${academy.origin}/ssacademy/api/imports/${record.id}`, { headers: { origin: portal.origin }, data: { revision: 1, data: exportData } });
  expect(rejected.status()).toBe(403);
  expect((await page.request.get(`${academy.origin}/ssacademy/api/imports?scope=all`)).status()).toBe(403);
  await page.goto('/ssacademy/#tokens');
  await expect(page.locator('#tokens-view')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collection exports.' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Administrator access is required');
});