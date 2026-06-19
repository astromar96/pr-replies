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

// Build a withRetry(attempt, onAttempt) bound to these timing params. attempt()
// resolves to a success result or throws; the thrown message decides
// retryability. Backoff: baseMs * 2^(n-2) + 0-250ms jitter.
function makeWithRetry({ sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4, baseMs = 1000 } = {}) {
  return async function withRetry(attempt, onAttempt) {
    let lastError = '';
    for (let n = 1; n <= attempts; n++) {
      if (n > 1) {
        if (onAttempt) onAttempt(n, lastError);
        await sleep(baseMs * 2 ** (n - 2) + Math.floor(Math.random() * 250));
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

module.exports = { firstLine, parseResponse, isRetryable, RETRYABLE_PATTERNS, makeWithRetry };
