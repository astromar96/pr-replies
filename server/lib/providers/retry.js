'use strict';

/**
 * Shared retry/backoff kernel for provider CLIs (`gh`, `glab`). Extracted from
 * the original github.js so every provider gets identical exponential backoff
 * and the same defensive response parsing — a `gh`/`glab api` call exits 0 even
 * when the server returns HTTP 200 with an embedded `errors` array, so a
 * zero exit is not enough to trust a mutation.
 */

function firstLine(s) {
  return String(s || '').trim().split('\n')[0];
}

// Parse a CLI JSON response defensively: surface an embedded `errors[]` (or a
// missing expected field, raised by the caller) as a real failure so withRetry
// and the caller never read a false success.
function parseResponse(out, context) {
  let data;
  try {
    data = JSON.parse(out);
  } catch (_) {
    throw new Error(`${context}: could not parse response`);
  }
  if (data && Array.isArray(data.errors) && data.errors.length) {
    throw new Error(`${context}: ${data.errors[0].message || JSON.stringify(data.errors[0])}`);
  }
  return data || {};
}

const RETRYABLE_PATTERNS = [
  /HTTP (429|5\d\d)/,
  /rate limit/i,
  /submitted too quickly/i,
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up)/i,
];

function isRetryable(message) {
  const m = String(message || '');
  return RETRYABLE_PATTERNS.some((re) => re.test(m));
}

// Secondary (abuse) rate limits are transient but explicitly ask the client to
// back off for ~60s; gh/glab don't surface the Retry-After header, so without a
// floor the generic exponential backoff (~1s/2s/4s) burns every retry in ~7s
// and surfaces a spurious failure — exactly during the batch-resolve case
// retries exist for. Primary HTTP 429s keep the generic backoff (retrying a
// primary limit in seconds rarely helps; the short backoff just surfaces it).
const SECONDARY_RATE_PATTERNS = [
  /secondary rate/i,
  /submitted too quickly/i,
  /abuse/i,
];

function isSecondaryRateLimit(message) {
  const m = String(message || '');
  return SECONDARY_RATE_PATTERNS.some((re) => re.test(m));
}

// Build a withRetry(attempt, onAttempt) bound to these timing params. attempt()
// resolves to a success result or throws; the thrown message decides
// retryability. Backoff: max(baseMs * 2^(n-2), secondary-rate floor) + 0-250ms
// jitter — the floor only raises waits for secondary/abuse rate limits.
function makeWithRetry({
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4, baseMs = 1000, secondaryRateMs = 30000,
} = {}) {
  return async function withRetry(attempt, onAttempt) {
    let lastError = '';
    for (let n = 1; n <= attempts; n++) {
      if (n > 1) {
        if (onAttempt) onAttempt(n, lastError);
        const exp = baseMs * 2 ** (n - 2);
        const floor = isSecondaryRateLimit(lastError) ? secondaryRateMs : 0;
        await sleep(Math.max(exp, floor) + Math.floor(Math.random() * 250));
      }
      try {
        return await attempt();
      } catch (e) {
        lastError = e.message;
        if (!isRetryable(lastError)) break;
      }
    }
    return { ok: false, error: lastError };
  };
}

module.exports = {
  firstLine, parseResponse, isRetryable, isSecondaryRateLimit,
  RETRYABLE_PATTERNS, SECONDARY_RATE_PATTERNS, makeWithRetry,
};
