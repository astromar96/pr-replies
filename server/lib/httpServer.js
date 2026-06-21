'use strict';

/**
 * HTTP + SSE layer. Every route lives under /{token}/ on 127.0.0.1; the token
 * is the only auth. The Host header is checked against the loopback origin to
 * block DNS-rebinding. The page carries no injected payload — it boots from
 * GET /state, and GET /events replays events.jsonl from any seq so refresh
 * and reconnect are lossless.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const { validateTemplates } = require('./schema');

// Constant-time equality on the URL token segment, so a local attacker can't
// learn the token a character at a time from response timing. Length is checked
// first because timingSafeEqual requires equal-length buffers.
function tokenMatches(candidate, token) {
  if (candidate.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

const MAX_BODY_BYTES = 1024 * 1024;
const SSE_KEEPALIVE_MS = 25000;

function respond(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function respondJson(res, code, obj) {
  respond(res, code, 'application/json', JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Keep draining so the 413 response can still be written on this socket.
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// `state` is null in home (hub) mode — then only GET / + the read-only data
// plane are served; phase routes and SSE 404. `snapshot` overrides how GET
// /state is built (home mode supplies its own); `data` powers GET/POST data/*.
function createApp({ state = null, data = null, snapshot = null, token, html, onShutdown = () => {}, log = () => {} }) {
  const sseClients = new Set();
  const getSnapshot = snapshot || (state ? () => state.snapshot() : () => ({ mode: 'home' }));

  if (state) {
    state.onEvent((event) => {
      const frame = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of sseClients) {
        try { res.write(frame); } catch (_) { sseClients.delete(res); }
      }
    });
  }

  const keepalive = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(':ka\n\n'); } catch (_) { sseClients.delete(res); }
    }
  }, SSE_KEEPALIVE_MS);
  keepalive.unref();

  function handleSse(req, res, query) {
    const after = Number(query.get('after') ?? req.headers['last-event-id'] ?? 0) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', phase: state.phase, lastSeq: state.lastSeq })}\n\n`);
    for (const event of state.eventsSince(after)) {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  async function handleDataGet(res, sub, query) {
    if (!data) return respond(res, 404, 'text/plain', 'not found');
    if (sub === 'data/sessions') return respondJson(res, 200, { sessions: data.sessions() });
    if (sub === 'data/history') return respondJson(res, 200, { history: data.history() });
    if (sub === 'data/templates') return respondJson(res, 200, { templates: data.templates() });
    if (sub.startsWith('data/history/')) {
      const rec = data.historyDetail(sub.slice('data/history/'.length));
      if (!rec) return respond(res, 404, 'text/plain', 'not found');
      return respondJson(res, 200, rec);
    }
    return respond(res, 404, 'text/plain', 'not found');
  }

  async function handleDataPost(res, sub, body) {
    if (!data) return respond(res, 404, 'text/plain', 'not found');
    if (sub === 'data/templates') {
      const errors = validateTemplates(body);
      if (errors.length) return respondJson(res, 400, { error: 'templates failed validation', errors });
      return respondJson(res, 200, { templates: data.saveTemplates(body.templates) });
    }
    if (sub === 'data/decisions') {
      // Session-mode sidecar mirroring localStorage; never read by the phase machine.
      if (!state || !state.saveDecisionsDraft) return respond(res, 404, 'text/plain', 'not found');
      state.saveDecisionsDraft(body);
      return respondJson(res, 200, { ok: true });
    }
    return respond(res, 404, 'text/plain', 'not found');
  }

  async function route(req, res, sub, query) {
    if (req.method === 'GET') {
      if (sub === '' || sub === '/') return respond(res, 200, 'text/html; charset=utf-8', html());
      if (sub === 'state') return respondJson(res, 200, getSnapshot());
      if (sub === 'events') return state ? handleSse(req, res, query) : respond(res, 404, 'text/plain', 'not found');
      if (sub === 'data' || sub.startsWith('data/')) return handleDataGet(res, sub, query);
      return respond(res, 404, 'text/plain', 'not found');
    }
    if (req.method !== 'POST') return respond(res, 404, 'text/plain', 'not found');

    const body = await readJsonBody(req);
    if (sub === 'data' || sub.startsWith('data/')) return handleDataPost(res, sub, body);
    // Phase/control routes require a live session (home mode has none).
    if (!state) return respond(res, 404, 'text/plain', 'not found');
    switch (sub) {
      case 'triage/submit':
        state.submitTriage(body.decisions);
        return respondJson(res, 200, { ok: true });
      case 'triage/cancel':
        state.cancel('triage');
        return respondJson(res, 200, { ok: true });
      case 'fixing/abort':
        state.requestAbort();
        return respondJson(res, 200, { ok: true });
      case 'reply/submit': {
        // 202: posting continues async, progress streams over SSE. Sync
        // validation errors still reject before the response is written.
        const posting = state.submitReplies(body);
        // submitReplies now contains its own failures and always finalizes when
        // it can, so this rejection is unreachable — but if the loop ever does
        // reject, force the session terminal so `wait`/the browser never hang.
        if (posting && posting.catch) {
          posting.catch((e) => {
            log(`posting loop error: ${e.message}`);
            try { state.stop('stopped'); } catch (_) { /* already terminal */ }
          });
        }
        return respondJson(res, 202, { ok: true });
      }
      case 'reply/finish':
        state.finishReply();
        return respondJson(res, 200, { ok: true });
      case 'reply/cancel':
        state.cancel('reply');
        return respondJson(res, 200, { ok: true });
      case 'control/event':
        return respondJson(res, 200, state.controlEvent(body));
      case 'control/advance':
        await state.advanceToReply();
        return respondJson(res, 200, { ok: true });
      case 'control/shutdown':
        respondJson(res, 200, { ok: true });
        return onShutdown();
      default:
        return respond(res, 404, 'text/plain', 'not found');
    }
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const host = String(req.headers.host || '');
      const port = server.address() ? server.address().port : null;
      if (port && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return respond(res, 400, 'text/plain', 'bad host');
      }
      // Auth is the per-session URL token (first path segment), compared in
      // constant time. A bare /{token} with no trailing slash is also rejected,
      // matching the previous prefix check.
      const prefix = `/${token}/`;
      const seg = url.pathname.split('/')[1] || '';
      if (!tokenMatches(seg, token) || !url.pathname.startsWith(prefix)) {
        return respond(res, 404, 'text/plain', 'not found');
      }
      const sub = url.pathname.slice(prefix.length);
      route(req, res, sub, url.searchParams).catch((e) => {
        const code = e.statusCode || 500;
        respondJson(res, code, e.errors ? { error: e.message, errors: e.errors } : { error: e.message });
      });
    } catch (_) {
      // A malformed request-target must never crash the session.
      try { respond(res, 400, 'text/plain', 'bad request'); } catch (_) { /* socket gone */ }
    }
  });

  return { server, sseClients };
}

module.exports = { createApp, readJsonBody };
