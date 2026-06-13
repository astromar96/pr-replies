'use strict';

/**
 * HTTP + SSE layer. Every route lives under /{token}/ on 127.0.0.1; the token
 * is the only auth. The Host header is checked against the loopback origin to
 * block DNS-rebinding. The page carries no injected payload — it boots from
 * GET /state, and GET /events replays events.jsonl from any seq so refresh
 * and reconnect are lossless.
 */

const http = require('node:http');

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

function createApp({ state, token, html, onShutdown = () => {}, log = () => {} }) {
  const sseClients = new Set();

  state.onEvent((event) => {
    const frame = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch (_) { sseClients.delete(res); }
    }
  });

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

  async function route(req, res, sub, query) {
    if (req.method === 'GET') {
      if (sub === '' || sub === '/') return respond(res, 200, 'text/html; charset=utf-8', html());
      if (sub === 'state') return respondJson(res, 200, state.snapshot());
      if (sub === 'events') return handleSse(req, res, query);
      return respond(res, 404, 'text/plain', 'not found');
    }
    if (req.method !== 'POST') return respond(res, 404, 'text/plain', 'not found');

    const body = await readJsonBody(req);
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
        if (posting && posting.catch) posting.catch((e) => log(`posting loop error: ${e.message}`));
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
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) return respond(res, 404, 'text/plain', 'not found');
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
