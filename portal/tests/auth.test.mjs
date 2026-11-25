import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createAuthStore } from '../server/auth-store.mjs';
import { authenticatedServer } from './helpers.mjs';
import { readAuthConfig, sessionCookie } from '../server/auth.mjs';

const credential = () => ({ id: randomBytes(24).toString('base64url'), publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] });
function register(store, name, setupHash = null) {
  return store.registerUser({ name, userHandle: randomBytes(32).toString('base64url'), credential: credential(), setupHash });
}
function admin(store) {
  const { token } = store.issueEnrollmentCode('setup');
  return register(store, 'Administrator', store.checkEnrollmentCode(token, 'setup').tokenHash);
}

test('only an operator-authorized first account becomes admin; subsequent accounts await approval', () => {
  const store = createAuthStore();
  try {
    assert.throws(() => register(store, 'Uninvited'), /setup\/recovery/);
    assert.equal(store.isEmpty(), true);
    const owner = admin(store);
    assert.equal(owner.role, 'admin');
    assert.equal(owner.status, 'approved');
    assert.throws(() => store.issueEnrollmentCode('setup'), /already complete/);
    const member = register(store, 'Member');
    assert.equal(member.role, 'user');
    assert.equal(member.status, 'pending');
    assert.throws(() => store.createSession(member.id), /approved/);
    assert.throws(() => register(store, ' member '), /already registered/);
    store.updateUser(owner.id, member.id, { status: 'approved' });
    assert.equal(store.getSessionUser(store.createSession(member.id).token).id, member.id);
  } finally { store.close(); }
});

test('role changes and revocation immediately invalidate sessions; members cannot administer users', () => {
  const store = createAuthStore();
  try {
    const owner = admin(store);
    const member = register(store, 'Member');
    store.updateUser(owner.id, member.id, { status: 'approved' });
    const first = store.createSession(member.id);
    assert.throws(() => store.listUsers(member.id), /Administrator/);
    assert.throws(() => store.updateUser(member.id, member.id, { role: 'admin' }), /Administrator/);
    store.updateUser(owner.id, member.id, { role: 'admin' });
    assert.equal(store.getSessionUser(first.token), null);
    const second = store.createSession(member.id);
    store.updateUser(owner.id, member.id, { status: 'revoked' });
    assert.equal(store.getSessionUser(second.token), null);
    store.updateUser(owner.id, member.id, { status: 'approved' });
    assert.equal(store.getSessionUser(second.token), null);
    assert.throws(() => store.updateUser(owner.id, owner.id, { status: 'revoked' }), /own access/);
    store.updateUser(owner.id, member.id, { role: 'user' });
    assert.throws(() => store.updateUser(owner.id, owner.id, { role: 'user' }), /At least one/);
    assert.throws(() => store.deleteUser(owner.id, owner.id), /own account/);
  } finally { store.close(); }
});

test('passkeys are account-scoped, the last key is protected, and removing a key revokes sessions', () => {
  const store = createAuthStore();
  try {
    const owner = admin(store);
    const first = store.getPasskeys(owner.id)[0];
    assert.equal('publicKey' in first, false);
    assert.throws(() => store.deleteCredential(owner.id, first.id), /at least one/);
    store.addCredential(owner.id, credential(), 'Backup key');
    const session = store.createSession(owner.id);
    store.deleteCredential(owner.id, first.id);
    assert.equal(store.getSessionUser(session.token), null);
    assert.equal(store.getPasskeys(owner.id).length, 1);
    assert.equal(store.findCredential(first.id), null);
  } finally { store.close(); }
});

test('challenges are browser-bound, single-use, typed, and expire', () => {
  let clock = 0;
  const store = createAuthStore({ now: () => clock });
  try {
    const id = store.rememberChallenge('login', 'browser-one', { challenge: 'challenge-value' });
    assert.throws(() => store.takeChallenge(id, 'login', 'browser-two'), /expired/);
    assert.equal(store.takeChallenge(id, 'login', 'browser-one').challenge, 'challenge-value');
    assert.throws(() => store.takeChallenge(id, 'login', 'browser-one'), /expired/);
    const wrongType = store.rememberChallenge('register', 'browser-one', {});
    assert.throws(() => store.takeChallenge(wrongType, 'login', 'browser-one'), /expired/);
    assert.throws(() => store.takeChallenge(wrongType, 'register', 'browser-one'), /expired/);
    const expired = store.rememberChallenge('login', 'browser-one', {});
    clock = 6 * 60_000;
    assert.throws(() => store.takeChallenge(expired, 'login', 'browser-one'), /expired/);
  } finally { store.close(); }
});

test('recovery codes expire, are one-time, and replace lost passkeys while invalidating sessions', () => {
  let clock = 0;
  const store = createAuthStore({ now: () => clock });
  try {
    const owner = admin(store);
    const oldKey = store.getPasskeys(owner.id)[0].id;
    const session = store.createSession(owner.id);
    const { token } = store.issueEnrollmentCode('recovery', owner.id);
    const proof = store.checkEnrollmentCode(token, 'recovery');
    store.recoverAccount(owner.id, proof.tokenHash, credential(), 'Recovered passkey');
    assert.equal(store.getSessionUser(session.token), null);
    assert.equal(store.findCredential(oldKey), null);
    assert.throws(() => store.checkEnrollmentCode(token, 'recovery'), /expired/);
    const expired = store.issueEnrollmentCode('recovery', owner.id);
    clock = 16 * 60_000;
    assert.throws(() => store.checkEnrollmentCode(expired.token, 'recovery'), /expired/);
  } finally { store.close(); }
});

test('accounts and sessions persist across store restarts and expired sessions are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-auth-'));
  const path = join(directory, 'auth.sqlite');
  let clock = 0;
  let store = createAuthStore({ path, now: () => clock, sessionDays: 1 });
  try {
    const owner = admin(store);
    const session = store.createSession(owner.id);
    store.close();
    store = createAuthStore({ path, now: () => clock, sessionDays: 1 });
    assert.equal(store.getSessionUser(session.token).id, owner.id);
    clock = 86_400_001;
    assert.equal(store.getSessionUser(session.token), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('passkey configuration requires an exact HTTPS hostname or localhost origin', () => {
  assert.equal(readAuthConfig({ PASSKEY_ORIGIN: 'http://localhost:8080' }).rpID, 'localhost');
  for (const origin of ['http://192.168.1.1:8080', 'http://portal.example.com', 'https://portal.example.com/path']) {
    assert.throws(() => readAuthConfig({ PASSKEY_ORIGIN: origin }));
  }
  assert.throws(() => readAuthConfig({ PASSKEY_ORIGIN: 'https://portal.example.com', PASSKEY_RP_ID: 'other.example.com' }));
});

test('API and gateway checks require approved sessions; anonymous navigation redirects only to local app paths', async () => {
  const { server, headers, store, user } = await authenticatedServer({ staticDir: false });
  try {
    assert.equal((await server.inject('/api/portal/apps')).statusCode, 401);
    assert.equal((await server.inject('/api/portal/admin/users')).statusCode, 401);
    assert.equal((await server.inject('/api/portal/auth/check')).statusCode, 401);
    assert.equal((await server.inject({ url: '/api/portal/auth/check', headers })).statusCode, 204);
    const navigation = { 'x-forwarded-uri': '/grocy/shoppinglist?test=1', 'x-forwarded-method': 'GET', accept: 'text/html' };
    const redirect = await server.inject({ url: '/api/portal/auth/check', headers: navigation });
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, '/?returnTo=%2Fgrocy%2Fshoppinglist%3Ftest%3D1');
    for (const path of ['//evil.example/grocy/', '/grocy/api/system/info', '/grocy/../../other']) {
      assert.equal((await server.inject({ url: '/api/portal/auth/check', headers: { ...navigation, 'x-forwarded-uri': path } })).statusCode, 401);
    }
    store.revokeSessions(user.id, user.id);
    assert.equal((await server.inject({ url: '/api/portal/auth/check', headers })).statusCode, 401);
  } finally { await server.close(); }
});

test('admin mutations reject cross-origin requests, privilege escalation, and revoked sessions', async () => {
  const { server, headers, store, user } = await authenticatedServer({ staticDir: false });
  try {
    const member = register(store, 'Member');
    const url = `/api/portal/admin/users/${member.id}`;
    assert.equal((await server.inject({ method: 'PATCH', url, headers: { ...headers, origin: 'https://evil.example' }, payload: { status: 'approved' } })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url, headers, payload: { status: 'approved' } })).statusCode, 200);
    const memberSession = store.createSession(member.id);
    const memberHeaders = { ...headers, cookie: `${sessionCookie}=${memberSession.token}` };
    assert.equal((await server.inject({ url: '/api/portal/admin/users', headers: memberHeaders })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url: '/api/portal/auth/me', headers: memberHeaders, payload: { name: 'Member', role: 'admin' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'PATCH', url: `/api/portal/admin/users/${user.id}`, headers, payload: { role: 'user' } })).statusCode, 409);
    await server.inject({ method: 'PATCH', url, headers, payload: { status: 'revoked' } });
    assert.equal((await server.inject({ url: '/api/portal/apps', headers: memberHeaders })).statusCode, 401);
    const listing = await server.inject({ url: '/api/portal/admin/users', headers });
    assert.doesNotMatch(listing.body, /publicKey|user_handle|token_hash/);
  } finally { await server.close(); }
});

test('login options require the configured origin, are rate limited, and require user verification', async () => {
  const { server, headers } = await authenticatedServer({ staticDir: false });
  try {
    const url = '/api/portal/auth/login/options';
    assert.equal((await server.inject({ method: 'POST', url, payload: {} })).statusCode, 403);
    const response = await server.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().options.userVerification, 'required');
    assert.equal(response.json().options.rpId, 'localhost');
    const flow = response.cookies.find((entry) => entry.name === 'ssportal_passkey_flow');
    assert.equal(flow.httpOnly, true);
    assert.equal(flow.sameSite, 'Strict');
    const invalid = { requestId: response.json().requestId, response: { id: 'not-a-credential' } };
    assert.equal((await server.inject({ method: 'POST', url: '/api/portal/auth/login/verify', headers, payload: invalid })).statusCode, 400);
    const boundHeaders = { ...headers, cookie: `${headers.cookie}; ssportal_passkey_flow=${flow.value}` };
    assert.equal((await server.inject({ method: 'POST', url: '/api/portal/auth/login/verify', headers: boundHeaders, payload: invalid })).statusCode, 401);
    assert.equal((await server.inject({ method: 'POST', url: '/api/portal/auth/login/verify', headers: boundHeaders, payload: invalid })).statusCode, 400);
    let last;
    for (let index = 0; index < 22; index += 1) last = await server.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(last.statusCode, 429);
  } finally { await server.close(); }
});