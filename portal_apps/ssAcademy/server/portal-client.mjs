import { inputError } from './exports.mjs';

export function createPortalClient({ origin = process.env.PORTAL_INTERNAL_URL ?? 'http://portal:3000', fetchImpl = fetch } = {}) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/') throw new Error('PORTAL_INTERNAL_URL must be an HTTP(S) origin.');

  async function request(path, headers, options = {}, includeStatus = false) {
    let response;
    try {
      response = await fetchImpl(new URL(`/api/portal/integrations/ssacademy${path}`, base), {
        ...options, headers, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    } catch { throw inputError('The portal account service is unavailable.', 503); }
    if (response.status === 204) return null;
    let body;
    try { body = await response.json(); }
    catch { throw inputError('The portal account service returned an invalid response.', 503); }
    if (!response.ok) throw inputError(response.status >= 500 ? 'The portal account service is unavailable.' : body.error ?? 'Access denied.', response.status >= 500 ? 503 : response.status);
    return includeStatus ? { status: response.status, body } : body;
  }

  function credentials(incoming, sessionOnly = false) {
    const headers = {};
    if (incoming.cookie) headers.cookie = incoming.cookie;
    if (!sessionOnly && incoming.authorization) headers.authorization = incoming.authorization;
    return headers;
  }

  return {
    async identify(incoming) {
      const identity = await request('/identity', credentials(incoming));
      if (!identity?.user?.id || !['session', 'device-token'].includes(identity.authType) || typeof identity.origin !== 'string') {
        throw inputError('The portal account service returned an invalid identity.', 503);
      }
      return identity;
    },
    deviceRequest(action, incoming, body) {
      if (!['register', 'status'].includes(action)) throw inputError('Invalid device operation.');
      const headers = { 'content-type': 'application/json' };
      if (incoming.origin) headers.origin = incoming.origin;
      return request(`/devices/${action}`, headers, { method: 'POST', body: JSON.stringify(body) }, true);
    },
    tokens(incoming, method = 'GET', body, id, query) {
      const headers = credentials(incoming, true);
      if (incoming.origin) headers.origin = incoming.origin;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const parameters = query ? `?${new URLSearchParams(query)}` : '';
      return request(`/tokens${id ? `/${encodeURIComponent(id)}` : ''}${parameters}`, headers, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    },
  };
}