import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
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

function approveDevice(store, actorId, id, student, fingerprintToken) {
  const result = store.updateAcademyDevice(actorId, id, 'approved');
  assert.equal('bearerToken' in result, false);
  return store.claimAcademyBearerToken(student, fingerprintToken);
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

test('ssAcademy mobile enrollment waits for administrator approval and grants upload-only identity', async () => {
  const { server, store, user, headers } = await authenticatedServer({ staticDir: false });
  const path = '/api/portal/integrations/ssacademy';
  try {
    const member = register(store, 'Mobile user');
    store.updateUser(user.id, member.id, { status: 'approved' });
    const fingerprintToken = randomBytes(32).toString('hex');
    const payload = { student: member.name, fingerprintToken };
    const registered = await server.inject({ method: 'POST', url: `${path}/devices/register`, payload });
    assert.equal(registered.statusCode, 202);
    assert.equal(registered.json().device.status, 'pending');
    assert.equal(registered.json().device.student, member.name);
    assert.equal('username' in registered.json().device, false);
    assert.equal(registered.body.includes(fingerprintToken), false);
    assert.equal('userId' in registered.json().device, false);
    const id = registered.json().device.id;
    assert.equal((await server.inject({ method: 'POST', url: `${path}/devices/register`, payload })).statusCode, 200);
    let authorization = { authorization: `Bearer ${fingerprintToken}` };
    assert.equal((await server.inject({ url: `${path}/identity`, headers: authorization })).statusCode, 401);
    const memberHeaders = { ...headers, cookie: `${sessionCookie}=${store.createSession(member.id).token}` };
    assert.equal((await server.inject({ url: `${path}/tokens`, headers: memberHeaders })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url: `${path}/tokens/${id}`, headers: memberHeaders, payload: { status: 'approved' } })).statusCode, 403);
    const denied = await server.inject({ method: 'PATCH', url: `${path}/tokens/${id}`, headers: { ...headers, origin: 'https://other.example' }, payload: { status: 'approved' } });
    assert.equal(denied.statusCode, 403);
    const approved = await server.inject({ method: 'PATCH', url: `${path}/tokens/${id}`, headers, payload: { status: 'approved' } });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().device.student, member.name);
    assert.equal('username' in approved.json().device, false);
    assert.equal('bearerToken' in approved.json(), false);
    assert.equal((await server.inject({ method: 'POST', url: `${path}/devices/status`, payload: { ...payload, student: 'Other student' } })).statusCode, 404);
    const delivered = await server.inject({ method: 'POST', url: `${path}/devices/status`, payload });
    const bearerToken = delivered.json().bearerToken;
    assert.equal(delivered.headers['cache-control'], 'no-store');
    assert.match(bearerToken, /^[a-f0-9]{64}$/);
    assert.notEqual(bearerToken, fingerprintToken);
    assert.equal((await server.inject({ url: `${path}/identity`, headers: authorization })).statusCode, 401);
    authorization = { authorization: `Bearer ${bearerToken}` };
    const identity = await server.inject({ url: `${path}/identity`, headers: authorization });
    assert.equal(identity.json().user.id, member.id);
    assert.equal(identity.json().authType, 'device-token');
    assert.equal(identity.headers['cache-control'], 'no-store');
    assert.equal((await server.inject({ url: '/api/portal/apps', headers: authorization })).statusCode, 401);
    assert.equal((await server.inject({ url: '/api/portal/admin/users', headers: authorization })).statusCode, 401);
    assert.equal((await server.inject({ url: `${path}/tokens`, headers: authorization })).statusCode, 401);
    const listing = await server.inject({ url: `${path}/tokens`, headers });
    assert.equal(listing.json().devices.length, 1);
    assert.equal(listing.json().devices[0].student, member.name);
    assert.equal('username' in listing.json().devices[0], false);
    assert.equal(listing.body.includes(fingerprintToken), false);
    assert.equal(listing.body.includes('token_hash'), false);
    assert.equal(listing.body.includes(bearerToken), false);
    const status = (await server.inject({ method: 'POST', url: `${path}/devices/status`, payload })).json().device;
    assert.equal(status.status, 'approved');
    assert.equal(status.student, member.name);
    assert.equal('username' in status, false);
    assert.equal('bearerToken' in status, false);
    const retried = await server.inject({ method: 'POST', url: `${path}/devices/register`, payload });
    assert.equal(retried.body.includes(bearerToken), false);
    const rotated = await server.inject({ method: 'PATCH', url: `${path}/tokens/${id}`, headers, payload: { status: 'approved' } });
    assert.equal('bearerToken' in rotated.json(), false);
    const replacementToken = (await server.inject({ method: 'POST', url: `${path}/devices/status`, payload })).json().bearerToken;
    assert.notEqual(replacementToken, bearerToken);
    assert.equal((await server.inject({ url: `${path}/identity`, headers: authorization })).statusCode, 401);
    authorization = { authorization: `Bearer ${replacementToken}` };
    assert.equal((await server.inject({ url: `${path}/identity`, headers: authorization })).statusCode, 200);
    assert.equal((await server.inject({ method: 'PATCH', url: `${path}/tokens/${id}`, headers, payload: { status: 'revoked' } })).statusCode, 200);
    assert.equal((await server.inject({ url: `${path}/identity`, headers: authorization })).statusCode, 401);
    assert.equal((await server.inject({ method: 'POST', url: `${path}/devices/register`, payload })).json().device.status, 'revoked');
    assert.equal((await server.inject({ method: 'DELETE', url: `${path}/tokens/${id}`, headers })).statusCode, 204);
    assert.equal((await server.inject({ url: `${path}/identity`, headers: { ...headers, authorization: 'Bearer invalid' } })).statusCode, 401);
    assert.equal((await server.inject({ method: 'POST', url: `${path}/tokens`, headers, payload: { name: 'Old generated token' } })).statusCode, 404);
  } finally { await server.close(); }
});

test('ssAcademy enrollment validates bodies, rejects untrusted browser origins, and rate limits requests', async () => {
  const { server, headers } = await authenticatedServer({ staticDir: false });
  const path = '/api/portal/integrations/ssacademy/devices';
  const fingerprintToken = randomBytes(32).toString('hex');
  try {
    for (const payload of [{ student: 'Mobile user' }, { student: 'Mobile user', fingerprintToken: 'short' }, { student: 'Mobile user', fingerprintToken, status: 'approved' }]) {
      assert.equal((await server.inject({ method: 'POST', url: `${path}/register`, payload })).statusCode, 400);
    }
    for (const action of ['register', 'status']) {
      for (const payload of [
        { username: 'Mobile user', fingerprintToken },
        { student: 'Mobile user', username: 'Mobile user', fingerprintToken },
      ]) {
        assert.equal((await server.inject({ method: 'POST', url: `${path}/${action}`, payload })).statusCode, 400);
      }
    }
    assert.equal((await server.inject({ method: 'POST', url: `${path}/register`, headers: { origin: 'https://other.example' }, payload: { student: 'Mobile user', fingerprintToken } })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: `${path}/status`, payload: { student: 'Mobile user', fingerprintToken } })).statusCode, 404);
    const registered = await server.inject({ method: 'POST', url: `${path}/register`, payload: { student: 'Mobile user', fingerprintToken } });
    assert.equal(registered.statusCode, 202);
    assert.equal((await server.inject({ method: 'POST', url: `${path}/status`, payload: { student: 'Another user', fingerprintToken } })).statusCode, 404);
    assert.equal((await server.inject({ url: '/api/portal/integrations/ssacademy/identity', headers: { ...headers, authorization: `Bearer ssa_${randomBytes(32).toString('base64url')}` } })).statusCode, 401);
    let response;
    for (let index = 0; index < 22; index++) response = await server.inject({ method: 'POST', url: `${path}/register`, payload: { student: 'Mobile user', fingerprintToken } });
    assert.equal(response.statusCode, 429);
  } finally { await server.close(); }
});

test('ssAcademy fingerprint enrollment requires admin approval and retries cannot reactivate revoked apps', () => {
  const store = createAuthStore();
  try {
    const administrator = admin(store);
    const member = register(store, 'Mobile user');
    store.updateUser(administrator.id, member.id, { status: 'approved' });
    const token = randomBytes(32).toString('hex');
    const registered = store.registerAcademyDevice(' Mobile user ', token);
    assert.equal(registered.created, true);
    assert.equal(registered.device.status, 'pending');
    assert.equal(store.getAcademyDeviceUser(token), null);
    assert.equal(JSON.stringify(registered).includes(token), false);
    const retry = store.registerAcademyDevice('mobile USER', token);
    assert.equal(retry.created, false);
    assert.equal(retry.device.id, registered.device.id);
    assert.equal(retry.device.status, 'pending');
    assert.throws(() => store.registerAcademyDevice('Someone else', token), { statusCode: 409 });
    assert.throws(() => store.listAcademyDevices(member.id), { statusCode: 403 });
    assert.throws(() => store.updateAcademyDevice(member.id, registered.device.id, 'approved'), { statusCode: 403 });
    const { bearerToken } = approveDevice(store, administrator.id, registered.device.id, 'Mobile user', token);
    assert.equal(store.getAcademyDeviceUser(token), null);
    assert.equal(store.getAcademyDeviceUser(bearerToken).id, member.id);
    assert.equal(store.listAcademyDevices(administrator.id, { status: 'approved' }).total, 1);
    store.updateAcademyDevice(administrator.id, registered.device.id, 'revoked');
    assert.equal(store.getAcademyDeviceUser(bearerToken), null);
    assert.equal(store.registerAcademyDevice('Mobile user', token).device.status, 'revoked');
    store.deleteAcademyDevice(administrator.id, registered.device.id);
    assert.equal(store.getAcademyDeviceUser(token), null);
    assert.equal(store.listAcademyDevices(administrator.id).total, 0);
    assert.equal(store.registerAcademyDevice('Mobile user', token).device.status, 'pending');
    assert.equal(store.getAcademyDeviceUser(token), null);
  } finally { store.close(); }
});

test('ssAcademy device approval preserves existing account ownership and survives restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-devices-'));
  const path = join(directory, 'auth.sqlite');
  let store = createAuthStore({ path });
  try {
    const administrator = admin(store);
    const token = randomBytes(32).toString('base64url');
    const member = register(store, 'New member');
    const registered = store.registerAcademyDevice('New member', token).device;
    const first = approveDevice(store, administrator.id, registered.id, 'New member', token);
    assert.equal(store.getAcademyDeviceUser(first.bearerToken).id, member.id);
    store.updateUser(administrator.id, member.id, { status: 'approved' });
    const { bearerToken } = approveDevice(store, administrator.id, registered.id, 'New member', token);
    store.close();
    store = createAuthStore({ path });
    assert.equal(store.getAcademyDeviceUser(bearerToken).id, member.id);
    store.updateUser(administrator.id, member.id, { name: 'Renamed member' });
    const replacement = register(store, 'New member');
    store.updateUser(administrator.id, replacement.id, { status: 'approved' });
    assert.equal(store.getAcademyDeviceUser(bearerToken).id, member.id);
    assert.equal(store.listAcademyDevices(administrator.id).devices[0].accountName, 'Renamed member');
    store.updateUser(administrator.id, member.id, { status: 'revoked' });
    store.updateUser(administrator.id, member.id, { status: 'approved' });
    assert.equal(store.getAcademyDeviceUser(bearerToken), null);
    assert.equal(store.getAcademyDeviceStatus('New member', token).status, 'revoked');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ssAcademy accountless approvals persist with isolated owners and never attach to later accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-independent-devices-'));
  const path = join(directory, 'auth.sqlite');
  let clock = 0;
  let store = createAuthStore({ path, now: () => clock });
  try {
    const administrator = admin(store);
    const token = randomBytes(32).toString('hex');
    const otherToken = randomBytes(32).toString('hex');
    const device = store.registerAcademyDevice('Student without account', token).device;
    const other = store.registerAcademyDevice('Student without account', otherToken).device;
    assert.equal(store.findUserByName('Student without account'), null);
    const approved = approveDevice(store, administrator.id, device.id, 'Student without account', token);
    const otherApproved = approveDevice(store, administrator.id, other.id, 'Student without account', otherToken);
    const owner = store.getAcademyDeviceUser(approved.bearerToken);
    assert.deepEqual(owner, { id: `ssacademy-device:${device.id}`, name: 'Student without account', role: 'user' });
    assert.notEqual(store.getAcademyDeviceUser(otherApproved.bearerToken).id, owner.id);
    store.close();
    store = createAuthStore({ path, now: () => clock });
    assert.deepEqual(store.getAcademyDeviceUser(approved.bearerToken), owner);
    const member = register(store, 'Student without account');
    store.updateUser(administrator.id, member.id, { status: 'approved' });
    assert.deepEqual(store.getAcademyDeviceUser(approved.bearerToken), owner);
    assert.equal(store.listAcademyDevices(administrator.id).devices.find((entry) => entry.id === device.id).userId, null);
    store.deleteUser(administrator.id, member.id);
    assert.deepEqual(store.getAcademyDeviceUser(approved.bearerToken), owner);
    clock = approved.device.expiresAt;
    assert.equal(store.getAcademyDeviceUser(approved.bearerToken), null);
    const renewed = approveDevice(store, administrator.id, device.id, 'Student without account', token);
    assert.deepEqual(store.getAcademyDeviceUser(renewed.bearerToken), owner);
    store.updateAcademyDevice(administrator.id, device.id, 'revoked');
    assert.equal(store.getAcademyDeviceUser(renewed.bearerToken), null);
    assert.equal(store.registerAcademyDevice('Student without account', token).device.status, 'revoked');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ssAcademy device validation, expiry, and recovery cannot bypass approval', () => {
  let clock = 0;
  const store = createAuthStore({ now: () => clock });
  try {
    const administrator = admin(store);
    for (const token of ['', 'short', 'x'.repeat(257), 'contains spaces'.repeat(4)]) {
      assert.throws(() => store.registerAcademyDevice(administrator.name, token), { statusCode: 400 });
    }
    const token = randomBytes(32).toString('hex');
    const device = store.registerAcademyDevice(administrator.name, token).device;
    const approved = approveDevice(store, administrator.id, device.id, administrator.name, token);
    clock = approved.device.expiresAt;
    assert.equal(store.getAcademyDeviceUser(approved.bearerToken), null);
    assert.equal(store.getAcademyDeviceStatus(administrator.name, token).status, 'expired');
    assert.equal(store.registerAcademyDevice(administrator.name, token).device.status, 'expired');
    assert.equal(store.listAcademyDevices(administrator.id, { status: 'expired' }).total, 1);
    assert.equal(store.listAcademyDevices(administrator.id, { status: 'approved' }).total, 0);
    const renewed = approveDevice(store, administrator.id, device.id, administrator.name, token);
    const recovery = store.issueEnrollmentCode('recovery', administrator.id);
    store.recoverAccount(administrator.id, store.checkEnrollmentCode(recovery.token, 'recovery').tokenHash, credential(), 'Recovered');
    assert.equal(store.getAcademyDeviceUser(renewed.bearerToken), null);
  } finally { store.close(); }
});

test('ssAcademy device searches are literal, paginated, and registration limits preserve existing retries', () => {
  const store = createAuthStore();
  try {
    const administrator = admin(store);
    const fingerprintToken = randomBytes(32).toString('hex');
    const special = store.registerAcademyDevice('Tablet_%!', fingerprintToken).device;
    for (const username of ['Tablet One', 'Tablet Two']) store.registerAcademyDevice(username, randomBytes(32).toString('hex'));
    const first = store.listAcademyDevices(administrator.id, { search: 'tablet', pageSize: 2 });
    const second = store.listAcademyDevices(administrator.id, { search: 'tablet', pageSize: 2, page: 2 });
    assert.equal(first.total, 3);
    assert.equal(first.devices.length, 2);
    assert.equal(second.devices.length, 1);
    assert.equal(new Set([...first.devices, ...second.devices].map((device) => device.id)).size, 3);
    assert.equal(store.listAcademyDevices(administrator.id, { search: '_%!' }).devices[0].id, special.id);
    assert.equal(store.listAcademyDevices(administrator.id, { search: '_%!' }).total, 1);
    for (const filters of [{ page: 0 }, { pageSize: 101 }, { status: 'anything' }]) assert.throws(() => store.listAcademyDevices(administrator.id, filters), { statusCode: 400 });
    for (let index = 1; index < 20; index++) store.registerAcademyDevice('Tablet_%!', randomBytes(32).toString('hex'));
    assert.throws(() => store.registerAcademyDevice('tablet_%!', randomBytes(32).toString('hex')), { statusCode: 429 });
    assert.equal(store.registerAcademyDevice('tablet_%!', fingerprintToken).device.id, special.id);
  } finally { store.close(); }
});

test('ssAcademy ignores legacy credentials and persists only identifier and bearer hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-device-migration-'));
  const path = join(directory, 'auth.sqlite');
  let store = createAuthStore({ path });
  try {
    const administrator = admin(store);
    const legacyToken = `ssa_${randomBytes(32).toString('base64url')}`;
    const fingerprintToken = randomBytes(32).toString('hex');
    store.close();
    const database = new DatabaseSync(path);
    try {
      database.exec(`DROP TABLE academy_devices;
        CREATE TABLE academy_upload_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER);`);
      database.prepare('INSERT INTO academy_upload_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run('legacy-device', createHash('sha256').update(legacyToken).digest('base64url'), administrator.id, 'Old tablet', Date.now(), Date.now() + 86_400_000);
    } finally { database.close(); }
    store = createAuthStore({ path });
    assert.equal(store.getUser(administrator.id).status, 'approved');
    assert.equal(store.getAcademyDeviceUser(legacyToken), null);
    const registered = store.registerAcademyDevice(administrator.name, fingerprintToken).device;
    const { bearerToken } = approveDevice(store, administrator.id, registered.id, administrator.name, fingerprintToken);
    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspected.prepare('SELECT token_hash FROM academy_devices').get().token_hash, createHash('sha256').update(fingerprintToken).digest('hex'));
      assert.equal(inspected.prepare('SELECT sync_token_hash FROM academy_devices').get().sync_token_hash, createHash('sha256').update(bearerToken).digest('base64url'));
      assert.equal(JSON.stringify(inspected.prepare('SELECT * FROM academy_devices').get()).includes(bearerToken), false);
      assert.equal(inspected.prepare('SELECT sync_token_nonce FROM academy_devices').get().sync_token_nonce, null);
      assert.equal(inspected.prepare('SELECT count(*) AS count FROM academy_upload_tokens').get().count, 1);
    } finally { inspected.close(); }
    assert.equal(store.getAcademyDeviceUser(fingerprintToken), null);
    assert.equal(store.getAcademyDeviceUser(bearerToken).id, administrator.id);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ssAcademy migrates fingerprint-authenticated registrations without granting bearer access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-bearer-migration-'));
  const path = join(directory, 'auth.sqlite');
  let store = createAuthStore({ path });
  try {
    const administrator = admin(store);
    const fingerprintToken = randomBytes(32).toString('hex');
    const device = store.registerAcademyDevice('Existing student', fingerprintToken).device;
    store.updateAcademyDevice(administrator.id, device.id, 'approved');
    store.close();
    const database = new DatabaseSync(path);
    try {
      database.exec('DROP INDEX academy_devices_sync_token; ALTER TABLE academy_devices DROP COLUMN sync_token_hash');
    } finally { database.close(); }
    store = createAuthStore({ path });
    const migrated = store.getAcademyDeviceStatus('Existing student', fingerprintToken);
    assert.equal(migrated.id, device.id);
    assert.equal(migrated.status, 'approved');
    assert.equal(migrated.hasBearerToken, false);
    assert.equal(store.getAcademyDeviceUser(fingerprintToken), null);
    const approved = approveDevice(store, administrator.id, device.id, 'Existing student', fingerprintToken);
    assert.equal(approved.device.id, device.id);
    assert.equal(approved.device.hasBearerToken, true);
    assert.equal(store.getAcademyDeviceUser(approved.bearerToken).id, `ssacademy-device:${device.id}`);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ssAcademy pending bearer delivery survives restarts and fails closed without its key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-token-delivery-'));
  const path = join(directory, 'auth.sqlite');
  let store = createAuthStore({ path });
  try {
    const administrator = admin(store);
    const fingerprintToken = randomBytes(32).toString('hex');
    const device = store.registerAcademyDevice('Waiting student', fingerprintToken).device;
    const approval = store.updateAcademyDevice(administrator.id, device.id, 'approved');
    assert.equal('bearerToken' in approval, false);
    assert.equal('bearerToken' in store.registerAcademyDevice('Waiting student', fingerprintToken).device, false);
    const keyPath = `${path}.sync-key`;
    const key = await readFile(keyPath);
    store.close();
    await rm(keyPath);
    store = createAuthStore({ path });
    assert.throws(() => store.claimAcademyBearerToken('Waiting student', fingerprintToken), /delivery key is missing/);
    store.close();
    await writeFile(keyPath, key, { mode: 0o600 });
    store = createAuthStore({ path });
    assert.throws(() => store.claimAcademyBearerToken('Other student', fingerprintToken), { statusCode: 404 });
    const delivered = store.claimAcademyBearerToken('Waiting student', fingerprintToken);
    assert.match(delivered.bearerToken, /^[a-f0-9]{64}$/);
    assert.equal(store.claimAcademyBearerToken('Waiting student', fingerprintToken).bearerToken, undefined);
    assert.equal(store.getAcademyDeviceUser(delivered.bearerToken).id, `ssacademy-device:${device.id}`);
    store.close();
    store = createAuthStore({ path });
    assert.equal(store.claimAcademyBearerToken('Waiting student', fingerprintToken).bearerToken, undefined);
    assert.equal(store.getAcademyDeviceUser(delivered.bearerToken).id, `ssacademy-device:${device.id}`);
    store.updateAcademyDevice(administrator.id, device.id, 'approved');
    store.updateAcademyDevice(administrator.id, device.id, 'revoked');
    assert.equal(store.claimAcademyBearerToken('Waiting student', fingerprintToken).bearerToken, undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ssAcademy concurrent status requests deliver a bearer secret to only one request', async () => {
  const { server, store, user, headers } = await authenticatedServer({ staticDir: false });
  const path = '/api/portal/integrations/ssacademy';
  try {
    const payload = { student: 'Polling student', fingerprintToken: randomBytes(32).toString('hex') };
    const registered = await server.inject({ method: 'POST', url: `${path}/devices/register`, payload });
    const id = registered.json().device.id;
    await server.inject({ method: 'PATCH', url: `${path}/tokens/${id}`, headers, payload: { status: 'approved' } });
    const responses = await Promise.all(Array.from({ length: 2 }, () => server.inject({ method: 'POST', url: `${path}/devices/status`, payload })));
    const delivered = responses.map((response) => response.json()).filter((body) => body.bearerToken);
    assert.equal(delivered.length, 1);
    assert.equal(store.getAcademyDeviceUser(delivered[0].bearerToken).id, `ssacademy-device:${id}`);
  } finally { await server.close(); }
});