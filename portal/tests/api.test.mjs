import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authenticatedServer } from './helpers.mjs';
import { createHealthMonitor } from '../server/health.mjs';

test('portal API exposes safe same-origin app metadata with independent health states', async () => {
  const { server, headers } = await authenticatedServer({
    staticDir: false,
    monitor: createHealthMonitor({ fetchImpl: async () => new Response(null, { status: 302 }) }),
  });
  try {
    const response = await server.inject({ url: '/api/portal/apps', headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const result = response.json();
    assert.equal(result.apps.length, 2);
    assert.equal(result.apps[0].path, '/grocy/');
    assert.equal(result.apps[1].path, '/webtrees/');
    assert.equal(result.apps[0].health.state, 'online');
    assert.ok(result.server.memoryMb > 0);
    assert.equal(response.body.includes('healthUrl'), false);
    assert.equal(response.body.includes('http://grocy'), false);
    assert.ok(response.headers['content-security-policy'].includes("script-src 'self'"));
  } finally {
    await server.close();
  }
});

test('liveness does not depend on apps and unknown app/API routes never fall back to portal HTML', async () => {
  const { server } = await authenticatedServer({ staticDir: false, monitor: { checkAll: () => { throw new Error('Unavailable'); } } });
  try {
    const health = await server.inject('/api/portal/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    for (const url of ['/api/unknown', '/grocy/api/', '/webtrees/index.php', '/config/apps.json']) {
      const response = await server.inject(url);
      assert.equal(response.statusCode, 404);
      assert.match(response.headers['content-type'], /json/);
    }
    assert.equal((await server.inject({ method: 'POST', url: '/api/portal/apps' })).statusCode, 404);
  } finally {
    await server.close();
  }
});

test('static serving exposes only built assets and rejects encoded traversal paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssportal-static-'));
  let server;
  try {
    const publicDirectory = join(directory, 'public');
    await mkdir(publicDirectory);
    await writeFile(join(publicDirectory, 'index.html'), '<!doctype html><title>Portal fixture</title>');
    await writeFile(join(publicDirectory, 'app.js'), 'console.log("portal");');
    await writeFile(join(directory, 'private.txt'), 'PRIVATE_FIXTURE');
    ({ server } = await authenticatedServer({ apps: [], staticDir: publicDirectory }));
    const home = await server.inject('/');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Portal fixture/);
    assert.equal(home.headers['cache-control'], 'no-cache');
    assert.equal((await server.inject('/app.js')).statusCode, 200);
    for (const path of ['/private.txt', '/..%2fprivate.txt', '/%2e%2e/private.txt', '/%2e%2e%5cprivate.txt', '/api/portal/unknown']) {
      const response = await server.inject(path);
      assert.ok([400, 403, 404].includes(response.statusCode), `${path}: ${response.statusCode}`);
      assert.doesNotMatch(response.body, /PRIVATE_FIXTURE|Portal fixture/);
    }
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});