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
    return { user: { id: headers.cookie === 'other-session' ? 'owner-b' : headers.cookie === 'admin-session' ? 'administrator' : 'owner-a', name: 'User', role: headers.cookie === 'admin-session' ? 'admin' : 'user' }, authType: headers.authorization ? 'device-token' : 'session', origin };
  },
  async tokens() { return { devices: [], total: 0, page: 1, pageSize: 50 }; },
  async deviceRequest(action, headers, body) {
    return { status: action === 'register' ? 202 : 200, body: { device: { id: 'pending-app', student: body.student, status: 'pending', fingerprint: 'safe-display-id', expiresAt: null } } };
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

test('admin sessions can delete other owners records without relaxing member, token, or origin restrictions', async () => {
  const store = createStore();
  const original = store.importData('owner-b', data()).import;
  const server = await buildApp({ store, portal, staticDir: false });
  const url = `/ssacademy/api/imports/${original.id}`;
  const adminHeaders = { cookie: 'admin-session', origin };
  try {
    for (const headers of [
      sessionHeaders,
      { ...adminHeaders, authorization: 'Bearer admin-token' },
      { ...adminHeaders, origin: 'https://evil.example' },
      { cookie: 'admin-session' },
    ]) {
      assert.ok([403, 404].includes((await server.inject({ method: 'DELETE', url, headers })).statusCode));
      assert.equal(store.getImport('owner-b', original.id).id, original.id);
    }
    assert.equal((await server.inject({ method: 'DELETE', url, headers: adminHeaders })).statusCode, 204);
    assert.equal(store.listImports('administrator', {}, true).total, 0);
    assert.equal((await server.inject({ url, headers: adminHeaders })).statusCode, 404);
    assert.equal((await server.inject({ method: 'DELETE', url, headers: adminHeaders })).statusCode, 404);
  } finally { await server.close(); }
});

test('device tokens cannot list collections, delete, or manage tokens; session writes require the exact origin', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    assert.equal((await server.inject('/ssacademy/api/imports')).statusCode, 401);
    const token = { authorization: 'Bearer upload-only' };
    const uploaded = await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: token, payload: data() });
    assert.equal(uploaded.statusCode, 201);
    for (const url of ['/ssacademy/api/me', '/ssacademy/api/imports', '/ssacademy/api/tokens']) {
      assert.equal((await server.inject({ url, headers: token })).statusCode, 403);
    }
    assert.equal((await server.inject({ method: 'DELETE', url: `/ssacademy/api/imports/${uploaded.json().import.id}`, headers: token })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { cookie: 'test-session', origin: 'https://evil.example' }, payload: data() })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: { cookie: 'test-session' }, payload: data() })).statusCode, 403);
  } finally { await server.close(); }
});

test('device uploads include settings in owned downloads but not their receipt', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    const token = { authorization: 'Bearer approved' };
    const payload = data();
    payload.data.rewards = {};
    payload.data.pokemons = [];
    payload.data.settings = { show_timer: true, text_size_percent: 120 };
    const uploaded = await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: token, payload });
    assert.equal(uploaded.statusCode, 201);
    const receipt = uploaded.json().import;
    assert.equal('settings' in receipt, false);
    const downloaded = await server.inject({ url: `/ssacademy/api/imports/${receipt.id}`, headers: token });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.json().import.settings, payload.data.settings);
    assert.equal((await server.inject({ url: `/ssacademy/api/imports/${receipt.id}`, headers: { cookie: 'other-session' } })).statusCode, 404);
  } finally { await server.close(); }
});

test('device sync replaces the current owned source record and identical retries do not revise it', async () => {
  const store = createStore();
  const other = store.importData('owner-b', data()).import;
  const server = await buildApp({ store, portal, staticDir: false });
  const token = { authorization: 'Bearer approved' };
  const upload = payload => server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: token, payload });
  try {
    const first = await upload(data());
    assert.equal(first.statusCode, 201);
    const id = first.json().import.id;
    const changed = data();
    changed.data.rewards = { TOYS_1: { whole: 7, fragments: 0 } };
    changed.data.pokemons = ['BULBASAUR'];
    changed.data.settings = { show_timer: true };
    const response = await upload(changed);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { duplicate: false, updated: true, import: first.json().import });
    assert.equal(response.headers.location, `/ssacademy/api/imports/${id}`);
    const record = (await server.inject({ url: `/ssacademy/api/imports/${id}`, headers: token })).json().import;
    assert.equal(record.revision, 2);
    assert.equal(record.rewards.length, 1);
    assert.equal(record.rewards[0].id, 'TOYS_1');
    assert.equal(record.rewards[0].whole, 7);
    assert.deepEqual(record.animations, ['BULBASAUR']);
    assert.deepEqual(record.settings, { show_timer: true });
    const stored = store.getImport('owner-a', id);
    assert.equal(store.listImports('owner-a').total, 1);
    assert.deepEqual(store.getImport('owner-b', other.id), other);
    const retry = await upload(changed);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().duplicate, true);
    assert.deepEqual(store.getImport('owner-a', id), stored);
    assert.equal((await upload({ ...changed, data: { ...changed.data, settings: { show_timer: 'invalid' } } })).statusCode, 400);
    assert.deepEqual(store.getImport('owner-a', id), stored);
    const stale = await server.inject({ method: 'PATCH', url: `/ssacademy/api/imports/${id}`, headers: { cookie: 'admin-session', origin }, payload: { revision: 1, data: data().data } });
    assert.equal(stale.statusCode, 409);
    const restored = await upload(data());
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().duplicate, false);
    assert.equal(restored.json().import.id, id);
    assert.equal(store.getImport('owner-a', id).revision, 3);
    assert.deepEqual(store.getImport('owner-a', id).settings, { show_timer: true });
    assert.equal((await upload({ ...data(), source: 'Second tablet' })).statusCode, 201);
    assert.equal(store.listImports('owner-a').total, 2);
  } finally { await server.close(); }
});

test('approved device tokens can download only their own imports without a browser session', async () => {
  const store = createStore();
  const own = store.importData('owner-a', data()).import;
  const other = store.importData('owner-b', data()).import;
  const administrator = store.importData('administrator', data()).import;
  const server = await buildApp({
    store, staticDir: false,
    portal: {
      ...portal,
      async identify(headers) {
        if (headers.authorization === 'Bearer rejected') throw inputError('App token is not approved.', 401);
        if (headers.authorization === 'Bearer unavailable') throw inputError('Unavailable', 503);
        const identity = await portal.identify(headers);
        if (headers.authorization === 'Bearer administrator') identity.user = { id: 'administrator', role: 'admin' };
        return identity;
      },
    },
  });
  try {
    const url = `/ssacademy/api/imports/${own.id}`;
    const token = { authorization: 'Bearer approved' };
    const response = await server.inject({ url, headers: token });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().import.id, own.id);
    assert.equal(response.json().import.rewards[0].whole, 2);
    assert.deepEqual(response.json().import.animations, ['PIKACHU']);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal((await server.inject({ method: 'HEAD', url, headers: token })).statusCode, 200);
    assert.equal((await server.inject(url)).statusCode, 401);
    assert.equal((await server.inject({ url, headers: { authorization: 'Bearer rejected' } })).statusCode, 401);
    assert.equal((await server.inject({ url, headers: { authorization: 'Bearer unavailable' } })).statusCode, 503);
    assert.equal((await server.inject({ url: `/ssacademy/api/imports/${other.id}`, headers: token })).statusCode, 404);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports/missing', headers: token })).statusCode, 404);
    const adminToken = { authorization: 'Bearer administrator' };
    assert.equal((await server.inject({ url: `/ssacademy/api/imports/${administrator.id}`, headers: adminToken })).statusCode, 200);
    assert.equal((await server.inject({ url, headers: adminToken })).statusCode, 404);
    assert.equal((await server.inject({ url, headers: { cookie: 'admin-session' } })).statusCode, 200);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: token, payload: { revision: 1, data: data().data } })).statusCode, 403);
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
    assert.equal((await server.inject({ url: '/ssacademy/api/imports', headers: adminHeaders })).json().total, 1);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports?scope=mine', headers: adminHeaders })).json().total, 1);
    assert.equal((await server.inject({ url: '/ssacademy/api/imports?scope=all', headers: adminHeaders })).json().total, 1);
    const edited = await server.inject({ method: 'PATCH', url, headers: adminHeaders, payload });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().import.revision, 2);
    assert.equal(edited.json().import.ownerId, 'owner-a');
    assert.equal(edited.json().import.updatedBy, 'administrator');
    assert.equal((await server.inject({ url, headers: sessionHeaders })).json().import.rewards[0].whole, 12);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: adminHeaders, payload })).statusCode, 409);
    assert.equal((await server.inject({ method: 'PATCH', url, headers: adminHeaders, payload: { revision: 2, data: { ...changed, rewards: { LOLLIPOP: { whole: -1 } } } } })).statusCode, 400);
    const duplicate = await server.inject({ method: 'POST', url: '/ssacademy/api/imports', headers: sessionHeaders, payload: data() });
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(duplicate.json().import.rewards[0].whole, 12);
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

test('mobile enrollment accepts only JSON student/fingerprint pairs without exposing collection data', async () => {
  const server = await buildApp({ store: createStore(), portal, staticDir: false });
  try {
    const payload = { student: 'Mobile user', fingerprintToken: 'a'.repeat(64) };
    const registered = await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload });
    assert.equal(registered.statusCode, 202);
    assert.equal(registered.json().device.status, 'pending');
    assert.equal(registered.json().device.student, payload.student);
    assert.equal('username' in registered.json().device, false);
    assert.equal(registered.headers['cache-control'], 'no-store');
    assert.equal(registered.body.includes(payload.fingerprintToken), false);
    const status = await server.inject({ method: 'POST', url: '/ssacademy/api/devices/status', payload });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().device.student, payload.student);
    for (const action of ['register', 'status']) {
      for (const legacy of [
        { username: payload.student, fingerprintToken: payload.fingerprintToken },
        { ...payload, username: payload.student },
      ]) {
        assert.equal((await server.inject({ method: 'POST', url: `/ssacademy/api/devices/${action}`, payload: legacy })).statusCode, 400);
      }
    }
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { ...payload, status: 'approved' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { student: 'Mobile user' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/devices/register', payload: { ...payload, fingerprintToken: 'short' } })).statusCode, 400);
    assert.equal((await server.inject('/ssacademy/api/imports')).statusCode, 401);
    assert.equal((await server.inject({ url: '/ssacademy/api/tokens', headers: sessionHeaders })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PATCH', url: '/ssacademy/api/tokens/pending-app', headers: sessionHeaders, payload: { status: 'approved' } })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/ssacademy/api/tokens', headers: sessionHeaders, payload: { name: 'Old generated token' } })).statusCode, 404);
  } finally { await server.close(); }
});

test('mobile enrollment forwards only the request body and validated browser-origin context', async () => {
  const payload = { student: 'Mobile user', fingerprintToken: 'b'.repeat(64) };
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