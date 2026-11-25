export function createHealthMonitor({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheMs = 15_000,
  timeoutMs = 2_500,
} = {}) {
  const cache = new Map();
  const pending = new Map();

  async function probe(application) {
    if (!application.healthUrl) {
      return { state: 'unchecked', responseTime: null, checkedAt: null };
    }

    const key = `${application.id}:${application.healthUrl}`;
    const cached = cache.get(key);
    if (cached && now() - cached.timestamp < cacheMs) return cached.result;
    if (pending.has(key)) return pending.get(key);

    const request = (async () => {
      const started = now();
      let state = 'offline';
      let responseTime = null;

      try {
        const response = await fetchImpl(application.healthUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'ssPortal-health/1.0' },
        });
        responseTime = Math.max(0, now() - started);
        state = (response.status >= 200 && response.status < 400)
          || response.status === 401 || response.status === 403 ? 'online' : 'degraded';
        await response.body?.cancel();
      } catch {
        state = 'offline';
        responseTime = null;
      }

      const result = { state, responseTime, checkedAt: new Date(now()).toISOString() };
      cache.set(key, { timestamp: now(), result });
      return result;
    })();

    pending.set(key, request);
    try {
      return await request;
    } finally {
      pending.delete(key);
    }
  }

  return { checkAll: (applications) => Promise.all(applications.map(probe)) };
}