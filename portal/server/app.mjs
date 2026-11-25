import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { createHealthMonitor } from './health.mjs';
import { loadApps, publicApp } from './registry.mjs';
import { createAuthStore } from './auth-store.mjs';
import { readAuthConfig, registerAuth } from './auth.mjs';

export async function buildApp({
  apps,
  monitor = createHealthMonitor(),
  logger = false,
  staticDir = fileURLToPath(new URL('../dist', import.meta.url)),
  authStore,
  authConfig = readAuthConfig(),
  webauthn,
} = {}) {
  const registry = apps ?? await loadApps(process.env.APPS_CONFIG ?? new URL('../config/apps.json', import.meta.url));
  const server = Fastify({ logger, bodyLimit: 65_536, requestTimeout: 10_000, trustProxy: 1, ajv: { customOptions: { removeAdditional: false } } });
  const store = authStore ?? createAuthStore({
    path: process.env.AUTH_DB_PATH ?? fileURLToPath(new URL('../data/auth.sqlite', import.meta.url)),
    sessionDays: authConfig.sessionDays,
  });
  server.addHook('onClose', async () => store.close());
  server.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'Request failed');
    return reply.code(status).send({ error: status >= 500 ? 'The request could not be completed.' : error.message, code: error.code ?? 'REQUEST_FAILED' });
  });

  await server.register(helmet, {
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  });

  server.get('/api/portal/health', async () => ({ status: 'ok' }));

  const { requireUser } = await registerAuth(server, { store, config: authConfig, apps: registry, webauthn });

  server.get('/api/portal/apps', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const statuses = await monitor.checkAll(registry);
    return {
      apps: registry.map((application, index) => ({ ...publicApp(application), health: statuses[index] })),
      server: {
        version: '1.0.0',
        uptime: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      checkedAt: new Date().toISOString(),
    };
  });

  if (staticDir && existsSync(staticDir)) {
    await server.register(fastifyStatic, {
      root: staticDir,
      setHeaders(reply, path) {
        reply.header('Cache-Control', path.endsWith('.html')
          ? 'no-cache' : 'public, max-age=86400');
      },
    });
  }

  server.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Not found' }));
  return server;
}