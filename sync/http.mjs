// Small fetch wrapper: polite User-Agent, retries with backoff, JSON/text helpers.

const UA = "tarkov-helper/1.0 (local personal helper)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { "User-Agent": UA, ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(options.timeout ?? 120_000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.fatal = true;
        throw err;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (err.fatal) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${url}: ${lastError?.message ?? lastError}`);
}

export async function getJson(url, options) {
  const res = await fetchRetry(url, { ...options, headers: { Accept: "application/json", ...(options?.headers ?? {}) } });
  return res.json();
}

export async function getText(url, options) {
  const res = await fetchRetry(url, options);
  return res.text();
}

export { sleep };
