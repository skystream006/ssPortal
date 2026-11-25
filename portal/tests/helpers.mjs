import { randomBytes } from 'node:crypto';
import { buildApp } from '../server/app.mjs';
import { createAuthStore } from '../server/auth-store.mjs';
import { readAuthConfig, sessionCookie } from '../server/auth.mjs';

export async function authenticatedServer(options = {}) {
  const store = createAuthStore();
  const setup = store.issueEnrollmentCode('setup');
  const user = store.registerUser({
    name: 'Test administrator', userHandle: randomBytes(32).toString('base64url'),
    setupHash: store.checkEnrollmentCode(setup.token, 'setup').tokenHash,
    credential: { id: randomBytes(24).toString('base64url'), publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
  });
  const session = store.createSession(user.id);
  const authConfig = readAuthConfig({ PASSKEY_ORIGIN: 'http://localhost:4180' });
  const server = await buildApp({ ...options, authStore: store, authConfig });
  return { server, store, user, session, headers: { cookie: `${sessionCookie}=${session.token}`, origin: authConfig.origin } };
}

export function recoveryForUser(store, name) {
  const user = store.findUserByName(name);
  if (!user) throw new Error('Test user not found.');
  return store.issueEnrollmentCode('recovery', user.id);
}