import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';
import { inputError, FORMAT, MAX_EXPORT_BYTES } from '../server/exports.mjs';
import { createStore } from '../server/store.mjs';
import { createPortalClient } from '../server/portal-client.mjs';

const origin = 'https://portal.example.com';
const data = () => ({ source: 'Tablet', data: { format: FORMAT, version: 1, rewards: { LOLLIPOP: { whole: 2, fragments: 1 } }, pokemons: ['PIKACHU'] } });
const sessionHeaders = { cookie: 'test-session', origin };
const portal = {
  async identify(headers) {
    if (!headers.cookie && !headers.authorization) throw inputError('Sign in required.', 401);
    const syncApproved = headers.authorization === 'Bearer sync-admin';
    const admin = headers.cookie === 'admin-session' || headers.authorization === 'Bearer upload-admin' || syncApproved;
    return { user: { id: admin ? 'administrator' : headers.cookie === 'other-session' ? 'owner-b' : 'owner-a', name: 'User', role: admin ? 'admin' : 'user' },
      authType: headers.authorization ? 'device-token' : 'session', ...(syncApproved ? { syncApproved } : {}), origin };
  },
  async tokens() { return { devices: [], total: 0, page: 1, pageSize: 50 }; },
  async deviceRequest(action, headers, body) {
    return { status: action === 'register' ? 202 : 200, body: { device: { id: 'pending-app', username: body.username, status: 'pending', fingerprint: 'safe-display-id', expiresAt: null, syncApproved: false } } };
  },
};

test('JSON uploads become readable normalized records and duplicate retries are idempotent', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    const response = await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: sessionHeaders, payload: data() });
    assert.equal(response.statusCode, 201);
    const record = response.json().import;
    assert.equal(record.whole, 2);
    assert.equal(record.animations[0], 'PIKACHU');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: sessionHeaders, payload: data() })).statusCode, 200);
    const list = await server.inject({ url: '/ssacademy/api/imports?search=Tablet', headers: sessionHeaders });
    assert.equal(list.json().total, 1);
    assert.equal((await server.inject({ url: `/ssacademy/api/imports/${record.id}`, headers: sessionHeaders })).json().import.rewards[0].whole, 2);
    assert.equal((await server.inject({ url: `/ssacademy/api/imports/${record.id}`, headers: { cookie: 'other-session' } })).statusCode, 404);
    assert.equal((await server.inject({ method: 'DELETE', url: `/ssacademy/api/imports/${record.id}`, headers: { cookie: 'other-session', origin } })).statusCode, 404);
    assert.equal((await server.inject({ method: 'DELETE', url: `/ssacademy/api/imports/${record.id}`, headers: sessionHeaders })).statusCode, 204);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports', headers: sessionHeaders })).json().total, 0);
  } finally { await server.close(); }
});

test('upload tokens cannot read, delete, or manage tokens; session writes require the exact origin', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    assert.equal((await server.inject('/ssacademy/api/imports')).statusCode, 401);
    const token = { authorization: 'Bearer upload-only' };
    const uploaded = await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: token, payload: data() });
    assert.equal(uploaded.statusCode, 201);
    assert.equal('sync' in uploaded.json(), false);
    for (const url of ['/ssacademy/api/me', '/ssacademy/api/imports', '/ssacademy/api/tokens', '/ssacademy/api/sync']) {
      assert.equal((await server.inject({ url, headers: token })).statusCode, 403);
    }
    assert.equal((await server.inject({ method: 'DELETE', url: `/ssacademy/api/imports/${uploaded.json().import.id}`, headers: token })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { cookie: 'test-session', origin: 'https://evil.example' }, payload: data() })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { cookie: 'test-session' }, payload: data() })).statusCode, 403);
  } finally { await server.close(); }
});

test('owner sync reads only the bearer owner and conditionally writes a canonical head', async () => {
  const store = createStore();
  const server = await buildApp({ store, portal, staticDir: false });
  const sync = { authorization: 'Bearer sync-admin' };
  const admin = { cookie: 'admin-session', origin };
  const read = (headers = sync, query = '') => server.inject({ url: `/ssacademy/api/sync${query}`, headers });
  const post = (payload, headers = sync) => server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers, payload });
  try {
    const other = await post(data(), sessionHeaders);
    const empty = (await read()).json();
    assert.equal(empty.data, null);
    assert.ok(typeof empty.version === 'string' && empty.version.length > 0 && empty.version.length <= 160);
    assert.deepEqual((await read()).json(), empty);
    assert.equal((await read(admin)).statusCode, 403);
    assert.equal((await read(sync, '?source=Tablet&ownerId=owner-a')).statusCode, 400);
    for (const baseVersion of [null, 0, '', 'x'.repeat(161)]) assert.equal((await post({ ...data(), baseVersion })).statusCode, 400);
    for (const headers of [admin, { authorization: 'Bearer upload-only', 'x-sync-approved': 'true' }]) {
      assert.equal((await post({ ...data(), baseVersion: empty.version }, headers)).statusCode, 403);
    }
    const original = { ...data().data, pokemons: ['PIKACHU', 'BULBASAUR', 'PIKACHU'] };
    const attempts = await Promise.all(['Mobile', 'Tablet'].map((source) => post({ source, data: original, baseVersion: empty.version })));
    assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [201, 409]);
    assert.equal(store.listImports('administrator').total, 1);
    const saved = attempts.find((response) => response.statusCode === 201).json();
    assert.deepEqual(saved.sync.data, { ...original, pokemons: ['BULBASAUR', 'PIKACHU'] });
    assert.notEqual(saved.sync.version, empty.version);
    assert.deepEqual(Object.keys(saved.import).sort(), ['format', 'id', 'importedAt', 'source', 'version']);
    const downloaded = await read();
    assert.equal(downloaded.headers['cache-control'], 'no-store');
    assert.deepEqual(downloaded.json(), saved.sync);

    for (const path of ['me', 'schema', 'tokens', 'imports?scope=all', `imports/${saved.import.id}`, `imports/${other.json().import.id}`]) {
      assert.equal((await server.inject({ url: `/ssacademy/api/${path}`, headers: sync })).statusCode, 403);
    }
    const url = `/ssacademy/api/imports/${saved.import.id}`;
    const edited = { ...original, rewards: {}, pokemons: ['MEW'] };
    const payload = { revision: 1, data: edited };
    assert.equal((await server.inject({ method: 'PATCH', url, headers: sync, payload })).statusCode, 403);
    assert.equal((await server.inject({ method: 'DELETE', url, headers: sync })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: admin, payload })).statusCode, 200);
    const corrected = (await read()).json();
    assert.notEqual(corrected.version, saved.sync.version);
    assert.deepEqual(corrected.data, edited);
    const retry = { source: saved.import.source, data: original };
    assert.equal((await post({ ...retry, baseVersion: saved.sync.version })).statusCode, 409);
    const duplicate = await post({ ...retry, baseVersion: corrected.version });
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json().sync, corrected);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(store.listImports('administrator').total, 1);

    const uploadOnly = { authorization: 'Bearer upload-admin' };
    const archive = { source: 'Archive tablet', data: original };
    const archived = await post(archive, uploadOnly);
    assert.equal(archived.statusCode, 201);
    assert.equal('sync' in archived.json(), false);
    assert.deepEqual((await read()).json(), corrected);
    assert.equal((await post(archive, uploadOnly)).json().duplicate, true);
    assert.deepEqual((await read()).json(), corrected);
    assert.equal((await server.inject({ url: `/ssacademy/api/imports/${archived.json().import.id}`, headers: admin })).statusCode, 200);
  } finally { await server.close(); }
});

test('rejects file uploads, unsupported data, oversized requests, and fails closed on authentication outage', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { ...sessionHeaders, 'content-type': 'multipart/form-data; boundary=test' }, payload: '--test' })).statusCode, 415);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: sessionHeaders, payload: { source: 'Tablet', file: 'backup.json' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: sessionHeaders, payload: { ...data(), extra: 'not-allowed' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { ...sessionHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ padding: 'x'.repeat(MAX_EXPORT_BYTES + 4096) }) })).statusCode, 413);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports', headers: sessionHeaders })).json().total, 0);
  } finally { await server.close(); }
  const unavailable = await buildApp({ store: createStore(), portal: { identify: async () => { throw inputError('Unavailable', 503); } }, staticDir: false });
  try {
    assert.equal((await unavailable.inject('/ssacademy/api/imports')).statusCode, 503);
    assert.equal((await unavailable.inject('/ssacademy/health')).statusCode, 200);
  } finally { await unavailable.close(); }
});

test('portal identity requests use a fixed internal origin and forward no untrusted identity headers', async () => {
  const client = createPortalClient({ origin: 'http://portal:3000', fetchImpl: async (url, options) => {
    assert.equal(url.href, 'http://portal:3000/api/portal/integrations/ssacademy/identity');
    assert.deepEqual(options.headers, { cookie: 'cookie-value', authorization: 'Bearer token-value' });
    return new Response(JSON.stringify({ user: { id: 'verified-owner' }, authType: 'session', origin }));
  } });
  assert.equal((await client.identify({ cookie: 'cookie-value', authorization: 'Bearer token-value', 'x-user-id': 'forged-owner' })).user.id, 'verified-owner');
  const unavailable = createPortalClient({ fetchImpl: async () => { throw new Error('Offline'); } });
  await assert.rejects(unavailable.identify({}), { statusCode: 503 });
});

test('only admin browser sessions can alter values and inspect all owners', async () => {
  const store = createStore();
  const server = await buildApp({ store, portal, staticDir: false });
  const adminHeaders = { cookie: 'admin-session', origin };
  try {
    const original = (await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: sessionHeaders, payload: data() })).json().import;
    const url = `/ssacademy/api/imports/${original.id}`;
    const changed = data().data;
    changed.rewards.LOLLIPOP = { whole: 12, fragments: 2 };
    changed.pokemons = ['PIKACHU', 'BULBASAUR'];
    const payload = { revision: original.revision, data: changed };
    assert.equal((await server.inject({ method: 'PATCH', url, headers: sessionHeaders, payload })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: { ...adminHeaders, authorization: 'Bearer upload-only' }, payload })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: { ...adminHeaders, origin: 'https://evil.example' }, payload })).statusCode, 403);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports?scope=all', headers: sessionHeaders })).statusCode, 403);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports', headers: adminHeaders })).json().total, 0);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports?scope=all', headers: adminHeaders })).json().total, 1);
    const edited = await server.inject({ method: 'PATCH', url, headers: adminHeaders, payload });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().import.revision, 2);
    assert.equal(edited.json().import.ownerId, 'owner-a');
    assert.equal(edited.json().import.updatedBy, 'administrator');
    assert.equal((await server.inject({ url, headers: sessionHeaders })).json().import.rewards[0].whole, 12);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: adminHeaders, payload })).statusCode, 409);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: adminHeaders, payload: { revision: 2, data: { ...changed, rewards: { LOLLIPOP: { whole: -1 } } } } })).statusCode, 400);
    const duplicate = await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { authorization: 'Bearer upload-only' }, payload: data() });
    assert.equal(duplicate.json().duplicate, true);
    assert.equal('rewards' in duplicate.json().import, false);
    assert.equal('whole' in duplicate.json().import, false);
    assert.equal(store.getImport('owner-a', original.id).revision, 2);
  } finally { await server.close(); }
});

test('the viewer requires a session and serves only its intended public assets', async () => {
  const server = await buildApp({ store: createStore(), portal });
  try {
    const anonymous = await server.inject('/ssacademy/');
    assert.equal(anonymous.statusCode, 302);
    assert.equal(anonymous.headers.location, '/?returnTo=%2Fssacademy%2F');
    const page = await server.inject({ url: '/ssacademy/', headers: sessionHeaders });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Collection exports/);
    assert.equal(page.headers['cache-control'], 'no-store');
    for (const path of ['app.js', 'appearance.js', 'style.css', 'theme.css', 'lucide.js', 'fonts/manrope.woff2', 'fonts/space-grotesk.woff2']) {
      const response = await server.inject(`/ssacademy/assets/${path}`);
      assert.equal(response.statusCode, 200, path);
      assert.doesNotMatch(response.headers['content-type'], /text\/html/, path);
    }
    for (const path of ['/ssacademy/data/academy.sqlite', '/ssacademy/server/app.mjs', '/ssacademy/assets/fonts/toString', '/ssacademy/assets/..%2fserver/app.mjs']) {
      assert.ok([400, 403, 404].includes((await server.inject(path)).statusCode), path);
    }
  } finally { await server.close(); }
});

test('mobile registration accepts sync requests while status requires only the original pair', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    const payload = { username: 'Mobile user', fingerprintToken: 'a'.repeat(64) };
    const registered = await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload });
    assert.equal(registered.statusCode, 202);
    assert.equal(registered.json().device.status, 'pending');
    assert.equal(registered.json().device.syncApproved, false);
    assert.equal(registered.headers['cache-control'], 'no-store');
    assert.equal(registered.body.includes(payload.fingerprintToken), false);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/status', payload })).statusCode, 200);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { ...payload, requestSync: true } })).statusCode, 202);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/status', payload: { ...payload, requestSync: true } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { ...payload, syncApproved: true } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { ...payload, status: 'approved' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { username: 'Mobile user' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { ...payload, fingerprintToken: 'short' } })).statusCode, 400);
    assert.equal((await server.inject('/ssacademy/api/imports')).statusCode, 401);
    assert.equal((await server.inject({ url: '/ssacademy/api/tokens', headers: sessionHeaders })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url: '/ssacademy/api/tokens/pending-app', headers: sessionHeaders, payload: { status: 'approved' } })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/tokens', headers: sessionHeaders, payload: { name: 'Old generated token' } })).statusCode, 404);
  } finally { await server.close(); }
});

test('mobile enrollment forwards only the request body and validated browser-origin context', async () => {
  const payload = { username: 'Mobile user', fingerprintToken: 'b'.repeat(64), requestSync: true };
  const client = createPortalClient({ origin: 'http://portal:3000', fetchImpl: async (url, options) => {
    assert.equal(url.href, 'http://portal:3000/api/portal/integrations/ssacademy/devices/register');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), payload);
    assert.deepEqual(options.headers, { 'content-type': 'application/json', origin });
    return new Response(JSON.stringify({ device: { id: 'pending-app', status: 'pending' } }), { status: 202 });
  } });
  const result = await client.deviceRequest('register', { origin, authorization: 'Bearer ignored', 'x-user-id': 'forged' }, payload);
  assert.equal(result.status, 202);
  assert.equal(result.body.device.status, 'pending');
});