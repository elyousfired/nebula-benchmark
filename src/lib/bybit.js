// Single Bybit client: one place for URLs, timeouts, retries, rate limiting and
// fallback. No public CORS proxies: if the browser can't reach Bybit directly,
// requests go through this site's own /api/bybit function (whitelisted).

const DIRECT = 'https://api.bybit.com/v5/market';
const PROXY = '/api/bybit';

let route = 'direct'; // switches to 'proxy' after repeated network/CORS failures
let directFailures = 0;

export class BybitError extends Error {
  constructor(message, { retCode, status } = {}) {
    super(message);
    this.retCode = retCode;
    this.status = status;
  }
}

function buildUrl(endpoint, params, via) {
  const qs = new URLSearchParams(params);
  if (via === 'proxy') {
    qs.set('endpoint', endpoint);
    return `${PROXY}?${qs}`;
  }
  return `${DIRECT}/${endpoint}?${qs}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new BybitError(`HTTP ${res.status}`, { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** GET a Bybit v5 market endpoint with retries; throws BybitError on failure. */
export async function bybitGet(endpoint, params, { retries = 2, timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const via = route;
    try {
      const json = await fetchJson(buildUrl(endpoint, params, via), timeoutMs);
      if (json.retCode !== 0) {
        // 10006 / 10018 = rate limit -> back off and retry.
        if (json.retCode === 10006 || json.retCode === 10018) {
          lastErr = new BybitError(json.retMsg, { retCode: json.retCode });
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new BybitError(json.retMsg || 'Bybit error', { retCode: json.retCode });
      }
      if (via === 'direct') directFailures = 0;
      return json.result;
    } catch (e) {
      lastErr = e;
      if (e instanceof BybitError && e.retCode != null) throw e; // API said no: don't retry
      // Network / CORS / timeout: count it against the direct route.
      if (via === 'direct' && (!(e instanceof BybitError) || e.status === 403)) {
        directFailures++;
        if (directFailures >= 3) route = 'proxy';
      }
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function currentRoute() {
  return route;
}

export async function fetchTickers() {
  const r = await bybitGet('tickers', { category: 'spot' });
  return r.list || [];
}

export async function fetchKlines(symbol, interval, limit) {
  const r = await bybitGet('kline', { category: 'spot', symbol, interval, limit: String(limit) });
  return r.list || [];
}

/**
 * Run async tasks with bounded concurrency. `onProgress(done, total)` after each task.
 * Failed tasks resolve to { error } instead of rejecting the whole batch.
 */
export async function pool(items, worker, { concurrency = 8, onProgress, signal } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run() {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (error) {
        results[i] = { error };
      }
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
