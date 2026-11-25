import { test as base, expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { buildApp } from '../../server/app.mjs';
import { createAuthStore } from '../../server/auth-store.mjs';
import { readAuthConfig } from '../../server/auth.mjs';
import { createHealthMonitor } from '../../server/health.mjs';

export const virtualAuthenticator = {
  protocol: 'ctap2' as const, transport: 'internal' as const, hasResidentKey: true,
  hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
};

export async function enablePasskeys(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', { options: virtualAuthenticator });
  return { client, id: authenticatorId };
}

type Portal = { store: ReturnType<typeof createAuthStore>; origin: string; setupCode: string };
type Authenticator = { client: CDPSession; id: string };

export const test = base.extend<{ portal: Portal; authenticator: Authenticator; signedIn: boolean; accountReady: void }>({
  signedIn: [true, { option: true }],
  portal: async ({}, use) => {
    const store = createAuthStore();
    const setup = store.issueEnrollmentCode('setup');
    const config = readAuthConfig({ PASSKEY_ORIGIN: 'http://localhost' });
    const options = {
      authStore: store, authConfig: config,
      monitor: createHealthMonitor({ fetchImpl: async () => new Response(null, { status: 200 }) }),
    };
    const server = await buildApp(options);
    try {
      const listening = new URL(await server.listen({ host: '127.0.0.1', port: 0 }));
      listening.hostname = 'localhost';
      config.origin = listening.origin;
      await use({ store, origin: config.origin, setupCode: setup.token });
    } finally { await server.close(); }
  },
  baseURL: async ({ portal }, use) => { await use(portal.origin); },
  authenticator: async ({ page }, use) => {
    const authenticator = await enablePasskeys(page);
    try { await use(authenticator); }
    finally { await authenticator.client.detach(); }
  },
  accountReady: [async ({ page, portal, authenticator, signedIn }, use) => {
    if (signedIn) {
      await page.goto('/');
      await page.bringToFront();
      await page.getByLabel('Username', { exact: true }).fill('Test administrator');
      await page.getByLabel('Server setup code', { exact: true }).fill(portal.setupCode);
      await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your applications.' })).toBeVisible();
      expect(authenticator.id).toBeTruthy();
    }
    await use();
  }, { auto: true }],
});

export { expect };