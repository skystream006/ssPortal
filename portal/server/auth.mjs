import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import * as simpleWebAuthn from '@simplewebauthn/server';
import { authError, hashToken, normalizeName } from './auth-store.mjs';

export const sessionCookie = 'ssportal_session';
const flowCookie = 'ssportal_passkey_flow';
const prefix = '/api/portal/auth';
const nameSchema = { type: 'string', minLength: 2, maxLength: 64 };
const keyNameSchema = { type: 'string', minLength: 1, maxLength: 64 };
const codeSchema = { type: 'string', maxLength: 100 };
const verificationSchema = {
  type: 'object', additionalProperties: false, required: ['requestId', 'response'],
  properties: { requestId: { type: 'string', minLength: 43, maxLength: 43 }, response: { type: 'object' } },
};

export function readAuthConfig(environment = process.env) {
  const parsed = new URL(environment.PASSKEY_ORIGIN ?? 'http://localhost:8080');
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('PASSKEY_ORIGIN must be an HTTP(S) origin without a path.');
  }
  if (isIP(parsed.hostname)) throw new Error('Passkeys require a hostname, not an IP address. Use localhost for local development.');
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && !parsed.hostname.endsWith('.localhost')) {
    throw new Error('Passkeys require HTTPS except on localhost. Configure PASSKEY_ORIGIN and the HTTPS gateway.');
  }
  const rpID = environment.PASSKEY_RP_ID || parsed.hostname;
  if (rpID !== parsed.hostname) throw new Error('PASSKEY_RP_ID must match the portal hostname.');
  const sessionDays = Number(environment.SESSION_DAYS ?? 30);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 90) throw new Error('SESSION_DAYS must be between 1 and 90.');
  return { origin: parsed.origin, rpID, secure: parsed.protocol === 'https:', sessionDays, allowRegistration: environment.ALLOW_REGISTRATION !== 'false' };
}

export async function registerAuth(server, { store, config, apps, webauthn = simpleWebAuthn }) {
  await server.register(cookie);
  await server.register(rateLimit, { global: false, max: 30, timeWindow: '1 minute', cache: 5000 });
  server.decorateRequest('user', null);
  server.decorateRequest('sessionToken', null);
  server.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/portal/') || request.url.split('?')[0] === '/api/portal/health') return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    request.sessionToken = request.cookies[sessionCookie] ?? null;
    request.user = store.getSessionUser(request.sessionToken);
  });

  const requireUser = async (request) => {
    if (!request.user) throw authError(401, 'Sign in with a passkey to continue.', 'SIGN_IN_REQUIRED');
  };
  const requireAdmin = async (request) => {
    await requireUser(request);
    if (request.user.role !== 'admin') throw authError(403, 'Administrator access is required.');
  };
  const requireOrigin = async (request) => {
    if (request.headers.origin !== config.origin) throw authError(403, 'This request did not come from the configured portal origin.', 'ORIGIN_MISMATCH');
  };
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.secure, path: '/' };

  function issueSession(request, reply, user) {
    store.deleteSession(request.sessionToken);
    const session = store.createSession(user.id);
    reply.setCookie(sessionCookie, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
  }

  function binding(request, reply) {
    let value = request.cookies[flowCookie];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) value = randomBytes(32).toString('base64url');
    reply.setCookie(flowCookie, value, { ...cookieOptions, path: prefix, maxAge: 300 });
    return value;
  }

  function remember(request, reply, kind, options, payload = {}) {
    const requestId = store.rememberChallenge(kind, binding(request, reply), {
      ...payload, challenge: options.challenge, origin: config.origin, rpID: config.rpID,
    });
    return { requestId, options };
  }

  function take(request, kind) {
    const challenge = store.takeChallenge(request.body.requestId, kind, request.cookies[flowCookie]);
    if (challenge.origin !== config.origin || challenge.rpID !== config.rpID) throw authError(400, 'The portal configuration changed. Try again.');
    return challenge;
  }

  const routeOptions = (body, protectedBy = null) => ({
    schema: { body },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: protectedBy ? [requireOrigin, protectedBy] : [requireOrigin],
  });
  const objectBody = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, required });

  async function registrationOptions(name, userHandle, excludeCredentials = []) {
    return webauthn.generateRegistrationOptions({
      rpName: 'ssPortal', rpID: config.rpID, userName: name, userDisplayName: name,
      userID: Buffer.from(userHandle, 'base64url'), attestationType: 'none', excludeCredentials,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
  }

  async function verifyRegistration(request, challenge) {
    try {
      const verification = await webauthn.verifyRegistrationResponse({
        response: request.body.response, expectedChallenge: challenge.challenge,
        expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) throw new Error('Unverified');
      return verification.registrationInfo.credential;
    } catch { throw authError(400, 'The passkey could not be verified. Please try again.', 'PASSKEY_INVALID'); }
  }

  server.get(`${prefix}/me`, async (request) => ({
    user: request.user, setupRequired: store.isEmpty(), registrationAllowed: config.allowRegistration,
    origin: config.origin, rpID: config.rpID,
  }));

  server.get(`${prefix}/check`, async (request, reply) => {
    if (request.user) return reply.code(204).send();
    const originalUri = request.headers['x-forwarded-uri'];
    const originalMethod = request.headers['x-forwarded-method'];
    if (typeof originalUri === 'string' && originalUri.length <= 2048 && originalUri.startsWith('/')
      && !originalUri.startsWith('//') && !/[\\\u0000-\u001f]/.test(originalUri)
      && ['GET', 'HEAD'].includes(originalMethod) && request.headers.accept?.includes('text/html')) {
      const destination = new URL(originalUri, config.origin);
      if (apps.some((application) => destination.pathname.startsWith(application.path)) && !destination.pathname.includes('/api/')) {
        return reply.redirect(`/?returnTo=${encodeURIComponent(destination.pathname + destination.search)}`, 302);
      }
    }
    throw authError(401, 'A portal passkey session is required.', 'SIGN_IN_REQUIRED');
  });

  server.post(`${prefix}/register/options`, routeOptions(objectBody({ name: nameSchema, passkeyName: keyNameSchema, setupCode: codeSchema }, ['name'])), async (request, reply) => {
    if (request.user) throw authError(409, 'Use account settings to add another passkey.');
    const name = normalizeName(request.body.name);
    let setupHash = null;
    if (store.isEmpty()) setupHash = store.checkEnrollmentCode(request.body.setupCode, 'setup').tokenHash;
    else if (!config.allowRegistration) throw authError(403, 'New account registration is disabled.');
    if (store.findUserByName(name)) throw authError(409, 'That username is already registered.');
    const userHandle = randomBytes(32).toString('base64url');
    return remember(request, reply, 'register', await registrationOptions(name, userHandle), {
      name, userHandle, setupHash, passkeyName: request.body.passkeyName ?? 'Primary passkey',
    });
  });

  server.post(`${prefix}/register/verify`, routeOptions(verificationSchema), async (request, reply) => {
    const challenge = take(request, 'register');
    if (!challenge.setupHash && !config.allowRegistration) throw authError(403, 'New account registration is disabled.');
    const credential = await verifyRegistration(request, challenge);
    const user = store.registerUser({ ...challenge, credential });
    if (user.status === 'approved') issueSession(request, reply, user);
    return reply.code(201).send({ user });
  });

  server.post(`${prefix}/login/options`, routeOptions(objectBody()), async (request, reply) => {
    const options = await webauthn.generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' });
    return remember(request, reply, 'login', options);
  });

  server.post(`${prefix}/login/verify`, routeOptions(verificationSchema), async (request, reply) => {
    const challenge = take(request, 'login');
    const match = store.findCredential(request.body.response.id);
    if (!match) throw authError(401, 'This passkey is not registered with ssPortal.', 'PASSKEY_UNKNOWN');
    const responseHandle = request.body.response.response?.userHandle;
    if (responseHandle && responseHandle !== match.userHandle) throw authError(401, 'The passkey does not belong to this account.');
    let verification;
    try {
      verification = await webauthn.verifyAuthenticationResponse({
        response: request.body.response, expectedChallenge: challenge.challenge, expectedOrigin: config.origin,
        expectedRPID: config.rpID, credential: match.credential, requireUserVerification: true,
      });
      if (!verification.verified) throw new Error('Unverified');
    } catch { throw authError(401, 'The passkey could not be verified. Please try again.', 'PASSKEY_INVALID'); }
    store.updateCounter(match.credential.id, match.credential.counter, verification.authenticationInfo.newCounter);
    const user = store.getUser(match.user.id);
    if (user?.status === 'pending') throw authError(403, 'Your account is waiting for administrator approval.', 'ACCESS_PENDING');
    if (user?.status !== 'approved') throw authError(403, 'Your access has been revoked.', 'ACCESS_REVOKED');
    issueSession(request, reply, user);
    return { user };
  });

  server.post(`${prefix}/logout`, routeOptions(objectBody()), async (request, reply) => {
    store.deleteSession(request.sessionToken);
    reply.clearCookie(sessionCookie, cookieOptions).clearCookie(flowCookie, { ...cookieOptions, path: prefix });
    return reply.code(204).send();
  });

  server.patch(`${prefix}/me`, routeOptions(objectBody({ name: nameSchema }, ['name']), requireUser), async (request) => ({
    user: store.renameUser(request.user.id, request.body.name),
  }));

  server.get(`${prefix}/passkeys`, { preHandler: requireUser }, async (request) => ({ passkeys: store.getPasskeys(request.user.id) }));

  server.post(`${prefix}/passkeys/options`, routeOptions(objectBody({ name: keyNameSchema }, ['name']), requireUser), async (request, reply) => {
    const keys = store.getPasskeys(request.user.id);
    if (keys.length >= 20) throw authError(409, 'An account can have at most 20 passkeys.');
    const options = await registrationOptions(request.user.name, store.getUserHandle(request.user.id), keys.map(({ id, transports }) => ({ id, transports })));
    return remember(request, reply, 'add-passkey', options, { userId: request.user.id, sessionHash: hashToken(request.sessionToken), name: request.body.name });
  });

  server.post(`${prefix}/passkeys/verify`, routeOptions(verificationSchema, requireUser), async (request, reply) => {
    const challenge = take(request, 'add-passkey');
    if (challenge.userId !== request.user.id || challenge.sessionHash !== hashToken(request.sessionToken)) throw authError(403, 'This request belongs to a different session.');
    const credential = await verifyRegistration(request, challenge);
    const user = store.addCredential(request.user.id, credential, challenge.name);
    return reply.code(201).send({ user, passkeys: store.getPasskeys(user.id) });
  });

  server.delete(`${prefix}/passkeys/:id`, { preHandler: [requireOrigin, requireUser] }, async (request, reply) => {
    const user = store.deleteCredential(request.user.id, request.params.id);
    issueSession(request, reply, user);
    return { user, passkeys: store.getPasskeys(user.id) };
  });

  server.post(`${prefix}/recover/options`, routeOptions(objectBody({ code: codeSchema, passkeyName: keyNameSchema }, ['code'])), async (request, reply) => {
    const proof = store.checkEnrollmentCode(request.body.code, 'recovery');
    const user = store.getUser(proof.userId);
    if (user?.status !== 'approved') throw authError(403, 'Recovery is not available for this account.');
    return remember(request, reply, 'recover', await registrationOptions(user.name, store.getUserHandle(user.id)), {
      userId: user.id, tokenHash: proof.tokenHash, name: request.body.passkeyName ?? 'Recovered passkey',
    });
  });

  server.post(`${prefix}/recover/verify`, routeOptions(verificationSchema), async (request, reply) => {
    const challenge = take(request, 'recover');
    const credential = await verifyRegistration(request, challenge);
    const user = store.recoverAccount(challenge.userId, challenge.tokenHash, credential, challenge.name);
    issueSession(request, reply, user);
    return { user };
  });

  server.get('/api/portal/admin/users', { preHandler: requireAdmin }, async (request) => ({ users: store.listUsers(request.user.id) }));

  server.patch('/api/portal/admin/users/:id', routeOptions(objectBody({
    name: nameSchema, role: { enum: ['admin', 'user'] }, status: { enum: ['pending', 'approved', 'revoked'] },
  }), requireAdmin), async (request) => ({ user: store.updateUser(request.user.id, request.params.id, request.body) }));

  server.delete('/api/portal/admin/users/:id', { preHandler: [requireOrigin, requireAdmin] }, async (request, reply) => {
    store.deleteUser(request.user.id, request.params.id);
    return reply.code(204).send();
  });

  server.post('/api/portal/admin/users/:id/revoke-sessions', routeOptions(objectBody(), requireAdmin), async (request, reply) => {
    store.revokeSessions(request.user.id, request.params.id);
    return reply.code(204).send();
  });

  return { requireUser };
}