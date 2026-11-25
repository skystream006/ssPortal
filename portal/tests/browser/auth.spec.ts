import { enablePasskeys, expect, test, virtualAuthenticator } from './fixtures';
import { recoveryForUser } from '../helpers.mjs';

test('approved sessions resume app deep links but never external redirects', async ({ page }) => {
  await page.route('**/grocy/shoppinglist', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Application destination</title>' }));
  await page.goto('/?returnTo=%2Fgrocy%2Fshoppinglist');
  await expect(page).toHaveURL(/\/grocy\/shoppinglist$/);
  await page.goto('/?returnTo=%2F%2Fevil.example%2F');
  await expect(page.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
  expect(new URL(page.url()).hostname).toBe('localhost');
  expect(new URL(page.url()).search).toBe('');
});

test('passkey login creates an HttpOnly session and logout invalidates it', async ({ page }) => {
  const before = (await page.context().cookies()).find((cookie) => cookie.name === 'ssportal_session')!;
  expect(before.httpOnly).toBe(true);
  expect(before.sameSite).toBe('Strict');
  expect(before.path).toBe('/');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to ssPortal' })).toBeVisible();
  expect((await page.request.get('/api/portal/apps')).status()).toBe(401);
  await page.bringToFront();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
  const after = (await page.context().cookies()).find((cookie) => cookie.name === 'ssportal_session')!;
  expect(after.value).not.toBe(before.value);
});

test('account settings rename the user and manage backup passkeys without removing the last key', async ({ page, portal, authenticator }, testInfo) => {
  await page.getByRole('link', { name: 'Account settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account settings.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Primary passkey' })).toBeDisabled();
  await page.getByLabel('Username', { exact: true }).fill('Updated administrator');
  await page.getByRole('button', { name: 'Save username' }).click();
  await expect(page.getByRole('status')).toContainText('Username saved');
  const owner = portal.store.findUserByName('Updated administrator')!;
  const previousSession = portal.store.createSession(owner.id);
  await authenticator.client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authenticator.id });
  authenticator.id = (await authenticator.client.send('WebAuthn.addVirtualAuthenticator', { options: virtualAuthenticator })).authenticatorId;
  await page.getByLabel('New passkey name').fill('Backup security key');
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Registered passkeys' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove Primary passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Registered passkeys' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove Backup security key' })).toBeDisabled();
  expect(portal.store.getSessionUser(previousSession.token)).toBeNull();
  expect((await page.request.get('/api/portal/apps')).status()).toBe(200);
  const keys = await (await page.request.get('/api/portal/auth/passkeys')).json();
  expect((await page.request.delete(`/api/portal/auth/passkeys/${keys.passkeys[0].id}`, { headers: { origin: portal.origin } })).status()).toBe(409);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('account.png'), fullPage: true });
});

test('administrators approve, change roles, revoke access, and delete accounts while members stay restricted', async ({ page, browser, portal }, testInfo) => {
  const memberContext = await browser.newContext({ baseURL: portal.origin });
  const memberPage = await memberContext.newPage();
  await enablePasskeys(memberPage);
  try {
    await memberPage.goto('/');
    await memberPage.getByRole('button', { name: 'Create account', exact: true }).click();
    await memberPage.getByLabel('Username', { exact: true }).fill('Pending member');
    await memberPage.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await expect(memberPage.getByRole('heading', { name: 'Awaiting approval' })).toBeVisible();
    expect((await memberPage.request.get('/api/portal/apps')).status()).toBe(401);
    await memberPage.getByRole('button', { name: 'Check approval' }).click();
    await expect(memberPage.getByRole('alert')).toContainText('waiting for administrator approval');

    await page.bringToFront();
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await page.getByRole('button', { name: 'Approve Pending member' }).click();
    await expect(page.getByRole('status')).toContainText('Pending member approved');
    await expect(page.getByRole('button', { name: 'Delete Test administrator' })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('users.png'), fullPage: true });

    await memberPage.bringToFront();
    await memberPage.getByRole('button', { name: 'Check approval' }).click();
    await expect(memberPage.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
    await expect(memberPage.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
    expect((await memberPage.request.get('/api/portal/admin/users')).status()).toBe(403);

    await page.bringToFront();
    await page.getByRole('button', { name: 'Edit Pending member' }).click();
    await page.getByRole('dialog').getByLabel('Role', { exact: true }).selectOption('admin');
    await page.getByRole('dialog').getByRole('button', { name: 'Save user' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await memberPage.request.get('/api/portal/apps')).status()).toBe(401);
    await memberPage.bringToFront();
    await memberPage.reload();
    await memberPage.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(memberPage.getByRole('link', { name: 'Users', exact: true })).toBeVisible();

    await page.bringToFront();
    await page.getByRole('button', { name: 'Revoke Pending member' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke access', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await memberPage.bringToFront();
    await memberPage.reload();
    await memberPage.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(memberPage.getByRole('alert')).toContainText('access has been revoked');
    expect((await memberPage.request.get('/api/portal/apps')).status()).toBe(401);

    await page.bringToFront();
    await page.getByRole('button', { name: 'Delete Pending member' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete account', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(portal.store.findUserByName('Pending member')).toBeNull();
  } finally { await memberContext.close(); }
});

test('operator-issued recovery enrolls a new verified passkey and invalidates the old keys', async ({ page, portal, authenticator }) => {
  const owner = portal.store.findUserByName('Test administrator')!;
  const oldKey = (await (await page.request.get('/api/portal/auth/passkeys')).json()).passkeys[0].id;
  const recovery = recoveryForUser(portal.store, 'Test administrator');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to ssPortal' })).toBeVisible();
  await authenticator.client.send('WebAuthn.clearCredentials', { authenticatorId: authenticator.id });
  await page.getByRole('button', { name: 'Recover account', exact: true }).click();
  await page.getByLabel('Recovery code', { exact: true }).fill(recovery.token);
  await page.getByRole('button', { name: 'Create recovery passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Application library.', level: 1 })).toBeVisible();
  expect(portal.store.findCredential(oldKey)).toBeNull();
  expect(() => portal.store.checkEnrollmentCode(recovery.token, 'recovery')).toThrow();
  expect(portal.store.getPasskeys(owner.id)).toHaveLength(1);
});

test.describe('First administrator setup', () => {
  test.use({ signedIn: false });
  test('rejects invalid setup codes and tampered attestations without creating an account', async ({ page, portal }, testInfo) => {
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill('Administrator');
    await page.getByLabel('Server setup code', { exact: true }).fill('invalid-code');
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid or expired');
    expect(portal.store.isEmpty()).toBe(true);
    await page.getByLabel('Server setup code', { exact: true }).fill(portal.setupCode);
    await page.route('**/api/portal/auth/register/verify', async (route) => {
      const payload = route.request().postDataJSON();
      payload.response.response.attestationObject = 'AA';
      await route.continue({ postData: JSON.stringify(payload) });
    });
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('passkey could not be verified');
    expect(portal.store.isEmpty()).toBe(true);
    await page.getByLabel('Server setup code', { exact: true }).fill('');
    await page.screenshot({ path: testInfo.outputPath('setup.png'), fullPage: true });
  });
});