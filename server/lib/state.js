'use strict';

/**
 * Session state machine: triage → fixing → reply → done | cancelled.
 *
 * Owns every mutation of session-dir state (result files, events.jsonl) and
 * notifies listeners (the SSE hub) of each recorded event. Reply posting is a
 * substate (`posting`), not a phase: partial failure keeps the phase at
 * `reply` so the browser can retry failed items or finish anyway —
 * reply.result.json is written once, cumulatively, at the terminal
 * transition.
 */

const { sessionPaths, writeAtomic, readJson, appendEvent, readEvents } = require('./session');
const { validateTriagePayload, validateReplyPayload } = require('./schema');

const SKILL_EVENT_TYPES = ['fix_start', 'fix_done', 'fix_fail', 'fix_skip', 'check', 'push', 'drafting', 'note'];
const EMIT_FIELDS = ['item', 'sha', 'summary', 'reason', 'name', 'status', 'detail', 'text'];

function httpError(statusCode, message, errors) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (errors) e.errors = errors;
  return e;
}

function createState({ sessionDir, flags = {}, config = {}, github, git, log = () => {} }) {
  const paths = sessionPaths(sessionDir);

  const st = {
    phase: null,
    posting: false,
    abortRequested: false,
    triagePayload: null,
    triageResult: null,
    replyPayload: null,
    replyResult: null,
    fixCommits: {},
    itemStatus: {},
    lastSeq: 0,
    events: [],
  };

  const results = { posted: [], errors: [], skipped: [], resolved: [], resolveErrors: [] };
  const postedKeys = new Set();
  const skippedKeys = new Set();
  const listeners = new Set();
  let onTerminalCb = () => {};
  let onChangeCb = () => {};

  function notifyChange() {
    try { onChangeCb(); } catch (e) { log(`onChange failed: ${e.message}`); }
  }

  function recordEvent(type, data = {}) {
    const event = { seq: ++st.lastSeq, at: new Date().toISOString(), type, ...data };
    st.events.push(event);
    appendEvent(sessionDir, event);
    for (const fn of listeners) {
      try { fn(event); } catch (_) { /* dead SSE client */ }
    }
    return event;
  }

  function setPhase(phase) {
    st.phase = phase;
    recordEvent('phase', { phase });
    notifyChange();
  }

  function payloadFor(target) {
    return target === 'triage' ? st.triagePayload : st.replyPayload;
  }

  function anyPayload() {
    return st.triagePayload || st.replyPayload;
  }

  function currentFailed() {
    return results.errors.filter((e) => !postedKeys.has(e.key));
  }

  function terminalResult(status) {
    return {
      status,
      posted: results.posted,
      errors: currentFailed(),
      skipped: results.skipped,
      resolved: results.resolved,
      resolveErrors: results.resolveErrors,
      at: new Date().toISOString(),
    };
  }

  // Terminal from any phase (stop / session timeout / SIGTERM). Writes the
  // result file the next `wait` would poll for: triage if the user never
  // submitted triage, the reply result otherwise.
  function terminate(status, reason) {
    if (st.phase === 'done' || st.phase === 'cancelled') return;
    if (st.phase === 'triage') {
      writeAtomic(paths.triageResult, { status, decisions: [], at: new Date().toISOString() });
    } else {
      writeAtomic(paths.replyResult, terminalResult(status));
    }
    st.posting = false;
    setPhase('cancelled');
    recordEvent('session_end', { reason });
    onTerminalCb(reason);
  }

  function finalizeReply(status, reason) {
    const result = terminalResult(status);
    writeAtomic(paths.replyResult, result);
    st.replyResult = result;
    setPhase('done');
    recordEvent('session_end', { reason });
    onTerminalCb(reason);
  }

  async function enrichFixCommits() {
    st.fixCommits = {};
    if (!git || !flags.repoDir || !st.replyPayload) return;
    const items = [
      ...st.replyPayload.reviewThreads.map((t) => ({ key: `review:${t.id}`, fixedIn: t.fixedIn })),
      ...st.replyPayload.issueComments.map((c) => ({ key: `issue:${c.databaseId}`, fixedIn: c.fixedIn })),
    ];
    for (const it of items) {
      if (!it.fixedIn) continue;
      const commit = await git.getFixCommit({ repoDir: flags.repoDir, sha: it.fixedIn });
      if (commit) st.fixCommits[it.key] = commit;
      else log(`fix diff unavailable for ${it.key} (${it.fixedIn})`);
    }
  }

  async function loadReplyPayload() {
    const payload = readJson(paths.replyPayload);
    if (!payload) throw httpError(400, 'cannot read reply.payload.json', ['reply.payload.json missing or invalid JSON']);
    const errors = validateReplyPayload(payload);
    if (errors.length) throw httpError(400, 'reply payload failed validation', errors);
    st.replyPayload = payload;
    st.itemStatus = {};
    await enrichFixCommits();
  }

  const api = {
    get phase() { return st.phase; },
    get posting() { return st.posting; },
    get abortRequested() { return st.abortRequested; },
    get lastSeq() { return st.lastSeq; },

    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onTerminal(fn) { onTerminalCb = fn; },
    onChange(fn) { onChangeCb = fn; },
    eventsSince(afterSeq) { return st.events.filter((e) => e.seq > afterSeq); },

    repoAndPr() {
      const p = anyPayload();
      return { repo: p ? p.repo.nameWithOwner : null, pr: p ? p.pr.number : null };
    },

    init({ startPhase = 'triage' } = {}) {
      if (startPhase === 'triage') {
        const payload = readJson(paths.triagePayload);
        const errors = payload ? validateTriagePayload(payload) : ['triage.payload.json missing or invalid JSON'];
        if (errors.length) throw httpError(400, 'triage payload failed validation', errors);
        st.triagePayload = payload;
        st.phase = 'triage';
        return Promise.resolve();
      }
      st.phase = 'reply';
      return loadReplyPayload();
    },

    // Rebuild from disk after a crash. postedKeys come from persisted
    // post_item events, so double-post protection survives the restart.
    async resume(previousPhase) {
      st.triagePayload = readJson(paths.triagePayload);
      st.triageResult = readJson(paths.triageResult);
      st.replyResult = readJson(paths.replyResult);
      st.events = readEvents(sessionDir, 0);
      st.lastSeq = st.events.length ? st.events[st.events.length - 1].seq : 0;
      // A 'posting'/'retrying' event with no later terminal event for the same
      // key means the process died mid-attempt: the comment may already have
      // landed on GitHub. Such keys are locked below so we never auto-repost.
      const inFlight = new Map();
      const settled = new Set();
      for (const e of st.events) {
        if (e.type === 'post_item' && e.status === 'posted') {
          postedKeys.add(e.key);
          settled.add(e.key);
          results.posted.push({ kind: e.kind, key: e.key, path: e.path, line: e.line, url: e.url });
          st.itemStatus[e.key] = { status: 'posted', url: e.url };
        } else if (e.type === 'post_item' && e.status === 'failed') {
          settled.add(e.key);
        } else if (e.type === 'post_item' && (e.status === 'posting' || e.status === 'retrying')) {
          inFlight.set(e.key, e);
        }
        if (e.type === 'resolve_item' && e.status === 'resolved') results.resolved.push({ key: e.key });
      }
      const interrupted = new Map();
      for (const [key, e] of inFlight) {
        if (settled.has(key)) continue;
        postedKeys.add(key); // lock: never auto-repost a possibly-posted reply
        interrupted.set(key, { status: 'interrupted', kind: e.kind, path: e.path, line: e.line });
      }
      if (readJson(paths.replyPayload)) await loadReplyPayload().catch((e) => log(`resume: ${e.message}`));
      // loadReplyPayload cleared itemStatus; restore posted (and interrupted) state.
      for (const key of postedKeys) {
        if (interrupted.has(key)) { st.itemStatus[key] = interrupted.get(key); continue; }
        const p = results.posted.find((x) => x.key === key);
        st.itemStatus[key] = { status: 'posted', url: p && p.url };
      }
      st.phase = previousPhase && previousPhase !== 'done' ? previousPhase : 'triage';
      st.posting = false;
    },

    submitTriage(decisions) {
      if (st.phase !== 'triage') throw httpError(409, `cannot submit triage in phase ${st.phase}`);
      if (!Array.isArray(decisions)) throw httpError(400, 'expected {decisions: [...]}');
      const result = { status: 'submitted', decisions, at: new Date().toISOString() };
      writeAtomic(paths.triageResult, result);
      st.triageResult = result;
      setPhase('fixing');
    },

    cancel(from) {
      if (st.phase !== from) throw httpError(409, `cannot cancel ${from} in phase ${st.phase}`);
      if (st.posting) throw httpError(409, 'posting in progress');
      if (from === 'triage') {
        writeAtomic(paths.triageResult, { status: 'cancelled', decisions: [], at: new Date().toISOString() });
        setPhase('cancelled');
        recordEvent('session_end', { reason: 'cancelled' });
        onTerminalCb('cancelled');
      } else {
        writeAtomic(paths.replyResult, terminalResult('cancelled'));
        setPhase('cancelled');
        recordEvent('session_end', { reason: 'cancelled' });
        onTerminalCb('cancelled');
      }
    },

    requestAbort() {
      if (st.phase !== 'fixing') throw httpError(409, `cannot abort in phase ${st.phase}`);
      if (!st.abortRequested) {
        st.abortRequested = true;
        recordEvent('note', { text: 'Abort requested — Claude will stop after the current fix.' });
        notifyChange();
      }
    },

    controlEvent(body) {
      if (st.phase === 'done' || st.phase === 'cancelled') throw httpError(409, 'session is over');
      if (!body || !SKILL_EVENT_TYPES.includes(body.type)) {
        throw httpError(400, `event type must be one of ${SKILL_EVENT_TYPES.join('|')}`);
      }
      const data = {};
      for (const f of EMIT_FIELDS) if (body[f] != null) data[f] = String(body[f]);
      recordEvent(body.type, data);
      return { ok: true, abort: st.abortRequested };
    },

    async advanceToReply() {
      if (st.phase !== 'fixing') throw httpError(409, `cannot advance to reply from phase ${st.phase}`);
      await loadReplyPayload();
      setPhase('reply');
    },

    submitReplies(body) {
      if (st.phase !== 'reply') throw httpError(409, `cannot submit replies in phase ${st.phase}`);
      if (st.posting) throw httpError(409, 'already posting');
      if (!body || !Array.isArray(body.replies)) throw httpError(400, 'expected {replies: [...]}');

      // Already-posted items are locked; a retry submission simply omits them,
      // but drop them defensively in case the client re-sends everything.
      const replies = body.replies.filter(
        (r) => r && typeof r.body === 'string' && r.body.trim() && !postedKeys.has(r.key),
      );
      for (const s of Array.isArray(body.skipped) ? body.skipped : []) {
        if (s && s.key && !skippedKeys.has(s.key) && !postedKeys.has(s.key)) {
          skippedKeys.add(s.key);
          results.skipped.push(s);
        }
      }
      st.posting = true;
      notifyChange();
      // Caller responds 202 immediately; progress streams over SSE.
      return (async () => {
        const { repo, pr } = api.repoAndPr();
        for (const r of replies) {
          let text = r.body.trim();
          if (config.signature) text += `\n\n${config.signature}`;
          st.itemStatus[r.key] = { status: 'posting', attempt: 1 };
          recordEvent('post_item', { key: r.key, kind: r.kind, path: r.path, line: r.line, status: 'posting', attempt: 1 });
          const onAttempt = (attempt, error) => {
            st.itemStatus[r.key] = { status: 'retrying', attempt, error };
            recordEvent('post_item', { key: r.key, kind: r.kind, status: 'retrying', attempt, error });
          };
          const out = r.kind === 'review'
            ? await github.postReviewReply(
                { repo, pr, threadId: r.threadId, replyToDatabaseId: r.replyToDatabaseId, body: text }, onAttempt)
            : await github.postIssueComment({ repo, pr, body: text }, onAttempt);
          if (out.ok) {
            postedKeys.add(r.key);
            results.errors = results.errors.filter((e) => e.key !== r.key);
            results.posted.push({ kind: r.kind, key: r.key, path: r.path, line: r.line, url: out.url });
            st.itemStatus[r.key] = { status: 'posted', url: out.url };
            recordEvent('post_item', { key: r.key, kind: r.kind, path: r.path, line: r.line, status: 'posted', url: out.url });
            log(`posted ${r.kind} reply${r.path ? ` (${r.path}:${r.line ?? '?'})` : ''}`);
            const thread = (st.replyPayload.reviewThreads || []).find((t) => t.id === r.threadId);
            if (r.kind === 'review' && r.resolve === true && thread && thread.viewerCanResolve) {
              const res = await github.resolveThread({ threadId: r.threadId });
              if (res.ok) {
                results.resolved.push({ key: r.key, threadId: r.threadId });
                recordEvent('resolve_item', { key: r.key, status: 'resolved' });
              } else {
                results.resolveErrors.push({ key: r.key, threadId: r.threadId, error: res.error });
                recordEvent('resolve_item', { key: r.key, status: 'failed', error: res.error });
              }
            }
          } else {
            results.errors = results.errors.filter((e) => e.key !== r.key);
            results.errors.push({ kind: r.kind, key: r.key, path: r.path, line: r.line, error: out.error, body: r.body });
            st.itemStatus[r.key] = { status: 'failed', error: out.error };
            recordEvent('post_item', { key: r.key, kind: r.kind, path: r.path, line: r.line, status: 'failed', error: out.error });
            log(`FAILED ${r.kind} reply: ${out.error}`);
          }
        }
        st.posting = false;
        const failed = currentFailed().length;
        recordEvent('post_done', { posted: results.posted.length, failed, skipped: results.skipped.length });
        notifyChange();
        if (failed === 0) finalizeReply('submitted', 'done');
      })();
    },

    finishReply() {
      if (st.phase !== 'reply') throw httpError(409, `cannot finish in phase ${st.phase}`);
      if (st.posting) throw httpError(409, 'posting in progress');
      finalizeReply('submitted', 'done');
    },

    stop(reason) { terminate(reason === 'timeout' ? 'timeout' : 'cancelled', reason); },

    snapshot() {
      const p = anyPayload();
      return {
        phase: st.phase,
        posting: st.posting,
        abortRequested: st.abortRequested,
        noPost: !!flags.noPost,
        repo: p ? p.repo : null,
        pr: p ? p.pr : null,
        config: {
          signature: config.signature || '',
          autoResolveFixedThreads: config.autoResolveFixedThreads !== false,
          defaultTriageAction: config.defaultTriageAction || null,
        },
        triage: { payload: st.triagePayload, result: st.triageResult },
        fixing: { events: st.events },
        reply: {
          payload: st.replyPayload,
          fixCommits: st.fixCommits,
          itemStatus: st.itemStatus,
          result: st.replyResult,
        },
        lastSeq: st.lastSeq,
      };
    },
  };

  return api;
}

module.exports = { createState, httpError };
