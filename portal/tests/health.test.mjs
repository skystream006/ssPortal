import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createHealthMonitor } from '../server/health.mjs';
import { loadApps, publicApp, validateApps } from '../server/registry.mjs';

const application = { id: 'grocy', healthUrl: 'http://grocy/grocy/' };

test('login redirects and authenticated endpoints count as reachable without following redirects', async () => {
  for (const status of [200, 302, 401, 403]) {
    const monitor = createHealthMonitor({
      fetchImpl: async (url, options) => {
        assert.equal(url, application.healthUrl);
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status });
      },
    });
    const [result] = await monitor.checkAll([application]);
    assert.equal(result.state, 'online');
    assert.ok(result.checkedAt);
  }
});

test('distinguishes upstream errors, unreachable services, and unmonitored apps', async () => {
  const monitor = createHealthMonitor({
    fetchImpl: async (url) => {
      if (url.includes('down')) throw new Error('Connection refused');
      return new Response(null, { status: 503 });
    },
  });
  const results = await monitor.checkAll([application, { id: 'down', healthUrl: 'http://down/' }, { id: 'external' }]);
  assert.deepEqual(results.map((result) => result.state), ['degraded', 'offline', 'unchecked']);
  assert.equal(results[1].responseTime, null);
});

test('coalesces concurrent requests, caches probes, and retries expired probes', async () => {
  let calls = 0;
  let clock = 0;
  const monitor = createHealthMonitor({
    now: () => clock,
    cacheMs: 100,
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 200 }); },
  });
  await Promise.all([monitor.checkAll([application]), monitor.checkAll([application])]);
  await monitor.checkAll([application]);
  assert.equal(calls, 1);
  clock = 101;
  await monitor.checkAll([application]);
  assert.equal(calls, 2);
});

test('bounds slow health checks with a real request timeout', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const monitor = createHealthMonitor({ timeoutMs: 80 });
    const [result] = await monitor.checkAll([{ id: 'slow', healthUrl: `http://127.0.0.1:${server.address().port}/` }]);
    assert.equal(result.state, 'offline');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('default applications use separate paths under the same hostname', async () => {
  const apps = await loadApps(new URL('../config/apps.json', import.meta.url), {});
  assert.deepEqual(apps.map((entry) => entry.path), ['/grocy/', '/webtrees/', '/ssacademy/']);
  assert.deepEqual(apps.map((entry) => entry.source), ['portal_apps/grocy/', 'portal_apps/webtrees/', 'portal_apps/ssAcademy/']);
  assert.equal(apps[0].apiPath, '/grocy/api/');
  assert.equal('healthUrl' in publicApp(apps[0]), false);
  assert.throws(() => validateApps([apps[0], apps[0]]), /unique/);
  for (const path of ['https://other.example/', '//other.example/', '/api/', '/assets/', '/../', '/']) {
    assert.throws(() => validateApps([{ ...apps[0], path }]), /same-origin/);
  }
  assert.throws(() => validateApps([{ ...apps[0], apiPath: '/api/grocy' }]), /inside/);
});