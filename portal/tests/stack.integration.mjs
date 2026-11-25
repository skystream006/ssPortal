import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import test from 'node:test';

const origin = process.env.STACK_URL ?? 'https://localhost:4125';
const authority = process.env.STACK_CA_CERT ? readFileSync(process.env.STACK_CA_CERT) : undefined;
const connectAddress = process.env.STACK_CONNECT_ADDRESS;
if (connectAddress && !isIP(connectAddress)) throw new Error('STACK_CONNECT_ADDRESS must be an IP address.');

function request(target, { body, ...options } = {}) {
  const url = new URL(target);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const connection = send(url, {
      ...options,
      ca: authority,
      lookup: connectAddress ? (hostname, lookupOptions, callback) => {
        const address = { address: connectAddress, family: isIP(connectAddress) };
        if (lookupOptions.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      } : undefined,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf8');
        const headers = new Headers(Object.entries(response.headers).flatMap(([name, values]) =>
          values === undefined ? [] : (Array.isArray(values) ? values : [values]).map((value) => [name, value])));
        resolve({ status: response.statusCode, headers, body: content, json: () => JSON.parse(content) });
      });
    });
    connection.setTimeout(15_000, () => connection.destroy(new Error('Request timed out.')));
    connection.on('error', reject);
    connection.end(body);
  });
}

const get = (path, options) => request(new URL(path, origin), options);

test('HTTPS origin matches passkey configuration and challenge cookies are Secure', async () => {
  assert.equal(new URL(origin).protocol, 'https:');
  const profile = (await get('/api/portal/auth/me')).json();
  assert.equal(profile.origin, new URL(origin).origin);
  assert.equal(profile.rpID, new URL(origin).hostname);
  const response = await get('/api/portal/auth/login/options', {
    method: 'POST', headers: { origin: profile.origin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.json().options.rpId, profile.rpID);
  assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/i);
});

test('HTTP redirects preserve app paths and queries on the configured HTTPS origin', async () => {
  const httpOrigin = process.env.STACK_HTTP_URL ?? 'http://localhost:8080';
  const response = await request(new URL('/grocy/shoppinglist?probe=1', httpOrigin));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), `${new URL(origin).origin}/grocy/shoppinglist?probe=1`);
});

test('one gateway serves the sign-in shell and exposes only public authentication and health information', async () => {
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/api/portal/health')).status, 200);
  const profile = await get('/api/portal/auth/me');
  assert.equal(profile.status, 200);
  assert.equal(profile.json().user, null);
  assert.equal((await get('/api/portal/apps')).status, 401);
  assert.equal((await get('/api/portal/admin/users')).status, 401);
});

test('app navigation preserves its path and returns to portal sign-in without changing hostname', async () => {
  for (const prefix of ['grocy', 'webtrees']) {
    const redirect = await get(`/${prefix}?probe=1`);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), `/${prefix}/?probe=1`);
    const page = await get(`/${prefix}/?probe=1`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 302);
    const target = new URL(page.headers.get('location'), origin);
    assert.equal(target.origin, new URL(origin).origin);
    assert.equal(target.searchParams.get('returnTo'), `/${prefix}/?probe=1`);
  }
});

test('app assets and APIs cannot bypass the portal session gate', async () => {
  for (const path of ['/grocy/img/icon-32.png', '/grocy/packages/bootstrap/dist/css/bootstrap.min.css', '/webtrees/public/css/webtrees.min.css', '/webtrees/public/js/webtrees.min.js', '/grocy/api/system/info']) {
    const response = await get(path);
    assert.equal(response.status, 401, path);
    assert.equal(response.json().code, 'SIGN_IN_REQUIRED');
  }
});

test('private app data and portal configuration are not publicly served', async () => {
  for (const path of ['/webtrees/data/config.ini.php', '/webtrees/vendor/autoload.php', '/webtrees/.git/config', '/grocy/data/config.php']) {
    assert.ok([401, 403, 404].includes((await get(path)).status), path);
  }
  assert.equal((await get('/config/apps.json')).status, 404);
  assert.equal((await get('/data/auth.sqlite')).status, 404);
  assert.equal((await get('/api/portal/unknown')).status, 404);
});