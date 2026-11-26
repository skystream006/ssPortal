import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { FORMAT, inputError, MAX_EXPORT_BYTES, MAX_WHOLE, REWARDS, UPSTREAM_REVISION, VERSION } from './exports.mjs';
import { createPortalClient } from './portal-client.mjs';
import { createStore } from './store.mjs';

const base = '/ssacademy';

export async function buildApp({
  store = createStore({ path: process.env.ACADEMY_DB_PATH ?? fileURLToPath(new URL('../data/academy.sqlite', import.meta.url)) }),
  portal = createPortalClient(), logger = false,
  staticDir = fileURLToPath(new URL('../public', import.meta.url)),
} = {}) {
  const server = Fastify({ logger, trustProxy: 1, bodyLimit: MAX_EXPORT_BYTES + 2048, requestTimeout: 15_000, ajv: { customOptions: { removeAdditional: false } } });
  server.decorateRequest('identity', null);
  server.addHook('onClose', async () => store.close());
  await server.register(helmet, {
    hsts: false,
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], fontSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'self'"], formAction: ["'self'"], upgradeInsecureRequests: null,
    } },
  });
  await server.register(rateLimit, { global: true, max: 180, timeWindow: '1 minute', cache: 5000 });
  server.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'ssAcademy request failed');
    reply.header('Cache-Control', 'no-store');
    return reply.code(status).send({ error: status >= 500 ? 'The service is temporarily unavailable.' : error.message });
  });
  server.get(`${base}/health`, { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  const requireSession = (request) => {
    if (request.identity.authType !== 'session') throw inputError('A portal browser session is required for this action.', 403);
  };
  const requireOrigin = (request) => {
    if (request.headers.origin !== request.identity.origin) throw inputError('The request origin does not match the portal.', 403);
  };
  const requireAdmin = (request) => {
    requireSession(request);
    if (request.identity.user.role !== 'admin') throw inputError('Administrator access is required for app approvals.', 403);
  };

  const deviceBody = {
    type: 'object', additionalProperties: false, required: ['student', 'fingerprintToken'],
    properties: {
      student: { type: 'string', minLength: 2, maxLength: 64 },
      fingerprintToken: { type: 'string', minLength: 32, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' },
    },
  };
  for (const action of ['register', 'status']) {
    server.post(`${base}/api/devices/${action}`, {
      bodyLimit: 1024, schema: { body: deviceBody }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw inputError('Send device details as application/json.', 415);
      const response = await portal.deviceRequest(action, request.headers, request.body);
      return reply.code(response.status).send(response.body);
    });
  }

  await server.register(async (routes) => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      request.identity = await portal.identify(request.headers);
      const tokenUpload = request.method === 'POST' && request.routeOptions.url === `${base}/api/imports`;
      const tokenDownload = ['GET', 'HEAD'].includes(request.method) && request.routeOptions.url === `${base}/api/imports/:id`;
      if (request.identity.authType === 'device-token' && !tokenUpload && !tokenDownload) throw inputError('This app token can only upload or download owned ssAcademy exports.', 403);
      if (!['GET', 'HEAD'].includes(request.method) && request.identity.authType === 'session') requireOrigin(request);
    });

    routes.get('/me', async (request) => ({ user: request.identity.user, format: FORMAT, version: VERSION }));
    routes.get('/schema', async () => ({ format: FORMAT, version: VERSION, maxExportBytes: MAX_EXPORT_BYTES, maxWhole: MAX_WHOLE, rewards: REWARDS, upstreamRevision: UPSTREAM_REVISION }));
    routes.get('/imports', async (request) => {
      const allowed = ['search', 'source', 'page', 'pageSize', 'scope'];
      if (Object.keys(request.query).some((key) => !allowed.includes(key))) throw inputError('Unknown import filter.');
      const { scope = 'mine', ...filters } = request.query;
      if (!['mine', 'all'].includes(scope)) throw inputError('Invalid import scope.');
      if (scope === 'all' && request.identity.user.role !== 'admin') throw inputError('Administrator access is required.', 403);
      return store.listImports(request.identity.user.id, filters, request.identity.user.role === 'admin');
    });
    routes.get('/imports/:id', async (request) => ({
      import: store.getImport(request.identity.user.id, request.params.id, request.identity.authType === 'session' && request.identity.user.role === 'admin'),
    }));
    routes.post('/imports', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw inputError('Send export data as application/json, not an uploaded file.', 415);
      const result = store.importData(request.identity.user.id, request.body, request.identity.user.name, { sync: request.identity.authType === 'device-token' });
      reply.header('Location', `${base}/api/imports/${result.import.id}`);
      const { id, source, format, version, importedAt } = result.import;
      const response = request.identity.authType === 'device-token' ? { duplicate: result.duplicate, ...(result.updated ? { updated: true } : {}), import: { id, source, format, version, importedAt } } : result;
      return reply.code(result.duplicate || result.updated ? 200 : 201).send(response);
    });
    routes.patch('/imports/:id', async (request) => {
      requireSession(request);
      if (request.identity.user.role !== 'admin') throw inputError('Administrator access is required to edit collection data.', 403);
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw inputError('Send changes as application/json.', 415);
      return { import: store.updateImport(request.identity.user, request.params.id, request.body) };
    });
    routes.delete('/imports/:id', async (request, reply) => {
      requireSession(request);
      store.deleteImport(request.identity.user.id, request.params.id);
      return reply.code(204).send();
    });
    routes.get('/tokens', async (request) => {
      requireAdmin(request);
      return portal.tokens(request.headers, 'GET', undefined, undefined, request.query);
    });
    routes.patch('/tokens/:id', async (request) => {
      requireAdmin(request);
      return portal.tokens(request.headers, 'PATCH', request.body, request.params.id);
    });
    routes.delete('/tokens/:id', async (request, reply) => {
      requireAdmin(request);
      await portal.tokens(request.headers, 'DELETE', undefined, request.params.id);
      return reply.code(204).send();
    });
  }, { prefix: `${base}/api` });

  if (staticDir && existsSync(staticDir)) {
    await server.register(fastifyStatic, {
      root: staticDir, prefix: `${base}/assets/`, index: false, maxAge: 0,
      setHeaders(reply, path) { if (path.endsWith('index.html')) reply.header('Cache-Control', 'no-store'); },
    });
    server.get(`${base}/`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        request.identity = await portal.identify(request.headers);
        requireSession(request);
      } catch (error) {
        if (error.statusCode === 401) return reply.redirect(`/?returnTo=${encodeURIComponent(`${base}/`)}`, 302);
        throw error;
      }
      return reply.sendFile('index.html');
    });
    server.get(`${base}/assets/theme.css`, async (request, reply) => {
      const path = process.env.PORTAL_THEME_PATH ?? fileURLToPath(new URL('../../../portal/src/themes.css', import.meta.url));
      return reply.type('text/css').header('Cache-Control', 'public, max-age=3600').send(await readFile(path));
    });
    server.get(`${base}/assets/fonts/:family`, async (request, reply) => {
      const fonts = { 'manrope.woff2': 'manrope', 'space-grotesk.woff2': 'space-grotesk' };
      const family = fonts[request.params.family];
      if (typeof family !== 'string') throw inputError('Font not found.', 404);
      const path = new URL(`../node_modules/@fontsource-variable/${family}/files/${family}-latin-wght-normal.woff2`, import.meta.url);
      return reply.type('font/woff2').header('Cache-Control', 'public, max-age=86400').send(await readFile(path));
    });
    server.get(`${base}/assets/lucide.js`, async (request, reply) => {
      return reply.type('text/javascript').header('Cache-Control', 'public, max-age=86400')
        .send(await readFile(new URL('../node_modules/lucide/dist/umd/lucide.min.js', import.meta.url)));
    });
  }
  server.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Not found' }));
  return server;
}