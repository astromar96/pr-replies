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

// An absent provider means GitHub (back-compat with pre-multi-provider
// payloads). Host defaults to the provider's SaaS domain when not pinned.
function providerName(payload) {
  return (payload && payload.provider) || 'github';
}
function providerHost(payload) {
  if (payload && payload.repo && payload.repo.host) return payload.repo.host;
  return providerName(payload) === 'gitlab' ? 'gitlab.com' : 'github.com';
}

// History decisions come from the browser submit (kind/threadId|databaseId/
// action/guidance). Enrich each with the reviewer (the thread's first comment
// author) and the agent's optional `category` looked up from the triage
// payload, so `suggest` can build per-reviewer and theme/category priors from
// history without any UI change. Existing fields win; missing ones are filled.
function enrichDecisions(decisions, triagePayload) {
  if (!triagePayload) return decisions || [];
  const byThread = {};
  const byComment = {};
  (triagePayload.reviewThreads || []).forEach((t) => { byThread[t.id] = t; });
  (triagePayload.issueComments || []).forEach((c) => { byComment[String(c.databaseId)] = c; });
  return (decisions || []).map((d) => {
    if (!d || (d.author && d.category)) return d;
    const src = d.threadId != null ? byThread[d.threadId]
      : (d.databaseId != null ? byComment[String(d.databaseId)] : null);
    if (!src) return d;
    const author = d.author || (src.comments && src.comments[0] && src.comments[0].author) || src.author;
    const category = d.category || src.category;
    const out = Object.assign({}, d);
    if (author && out.author == null) out.author = author;
    if (category && out.category == null) out.category = category;
    return out;
  });
}

function createState({ sessionDir, flags = {}, config = {}, provider, github, git, history = null, log = () => {} }) {
  // `provider` is the provider-neutral backend (github/gitlab); `github` is the
  // legacy keyword still passed by older callers and the unit-test fakes.
  const prov = provider || github;
  const paths = sessionPaths(sessionDir);
  let recorded = false;

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

  // Assemble the audit record from in-memory state; history.js owns the file
  // format. Recorded at most once per session; never lets a write break a
  // terminal transition.
  function buildRecord(status) {
    const { repo, pr } = api.repoAndPr();
    const p = anyPayload();
    return {
      repo,
      pr,
      provider: providerName(p),
      host: providerHost(p),
      prTitle: p && p.pr ? p.pr.title : null,
      prUrl: p && p.pr ? p.pr.url : null,
      endedAt: new Date().toISOString(),
      status,
      decisions: enrichDecisions((st.triageResult && st.triageResult.decisions) || [], st.triagePayload),
      posted: results.posted,
      errors: currentFailed(),
      skipped: results.skipped,
      resolved: results.resolved,
      resolveErrors: results.resolveErrors,
      fixCommits: Object.keys(st.fixCommits || {}).map((key) => ({
        key, sha: st.fixCommits[key].sha, subject: st.fixCommits[key].subject,
      })),
    };
  }

  function recordHistory(status) {
    if (recorded || !history) return;
    recorded = true;
    try { history.record(buildRecord(status)); } catch (e) { log(`history record failed: ${e.message}`); }
  }

  // A concise markdown roll-up of the session for an opt-in summary comment —
  // replies posted, threads resolved, and the fix commits pushed.
  function buildSummaryBody() {
    const posted = results.posted.length;
    const resolved = results.resolved.length;
    const fixes = Object.keys(st.fixCommits || {}).map((k) => st.fixCommits[k]);
    const lines = ['**pr-replies summary**', ''];
    if (posted) lines.push(`- Replied to ${posted} comment${posted === 1 ? '' : 's'}`);
    if (resolved) lines.push(`- Resolved ${resolved} thread${resolved === 1 ? '' : 's'}`);
    if (fixes.length) {
      lines.push(`- Pushed ${fixes.length} fix${fixes.length === 1 ? '' : 'es'}:`);
      fixes.forEach((f) => lines.push(`  - \`${f.sha}\`${f.subject ? ' ' + f.subject : ''}`));
    }
    if (!posted && !resolved && !fixes.length) lines.push('- No replies posted.');
    return lines.join('\n');
  }

  // The single terminal transition. Writes the result file the next `wait`
  // polls for, flips to the terminal phase, emits session_end, records history
  // (once), and fires onTerminalCb. Every terminal path — cancel, stop,
  // timeout, normal finish, and the posting loop's failure path — routes
  // through here, so a new terminal side-effect lands in exactly one place.
  // Idempotent: a second call once the session is already terminal is a no-op.
  function finalize({ phase, resultFile, result, status, reason }) {
    if (st.phase === 'done' || st.phase === 'cancelled') return;
    writeAtomic(resultFile, result);
    if (resultFile === paths.replyResult) st.replyResult = result;
    st.posting = false;
    setPhase(phase);
    recordEvent('session_end', { reason });
    recordHistory(status);
    onTerminalCb(reason);
  }

  // Terminal from any phase (stop / session timeout / SIGTERM). Writes the
  // result file the next `wait` would poll for: triage if the user never
  // submitted triage, the reply result otherwise.
  function terminate(status, reason) {
    if (st.phase === 'done' || st.phase === 'cancelled') return;
    const onTriage = st.phase === 'triage';
    finalize({
      phase: 'cancelled',
      resultFile: onTriage ? paths.triageResult : paths.replyResult,
      result: onTriage
        ? { status, decisions: [], at: new Date().toISOString() }
        : terminalResult(status),
      status,
      reason,
    });
  }

  function finalizeReply(status, reason) {
    finalize({
      phase: 'done',
      resultFile: paths.replyResult,
      result: terminalResult(status),
      status,
      reason,
    });
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
      finalize({
        phase: 'cancelled',
        resultFile: from === 'triage' ? paths.triageResult : paths.replyResult,
        result: from === 'triage'
          ? { status: 'cancelled', decisions: [], at: new Date().toISOString() }
          : terminalResult('cancelled'),
        status: 'cancelled',
        reason: 'cancelled',
      });
    },

    requestAbort() {
      if (st.phase !== 'fixing') throw httpError(409, `cannot abort in phase ${st.phase}`);
      if (!st.abortRequested) {
        st.abortRequested = true;
        const who = config.agentLabel || 'the agent';
        recordEvent('note', { text: `Abort requested — ${who} will stop after the current fix.` });
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
      // Record an item as failed (a provider {ok:false}, or an unexpected
      // throw). Mirrors the success path's bookkeeping so a thrown error and a
      // returned error are indistinguishable to the browser and to history.
      function recordItemFailure(r, error) {
        results.errors = results.errors.filter((e) => e.key !== r.key);
        results.errors.push({ kind: r.kind, key: r.key, path: r.path, line: r.line, error, body: r.body });
        st.itemStatus[r.key] = { status: 'failed', error };
        try {
          recordEvent('post_item', { key: r.key, kind: r.kind, path: r.path, line: r.line, status: 'failed', error });
        } catch (_) { /* event log unwritable — in-memory result still finalizes */ }
      }

      st.posting = true;
      notifyChange();
      // Caller responds 202 immediately; progress streams over SSE. The whole
      // loop is wrapped so a single item's unexpected throw never aborts the
      // rest, and a catastrophic throw still resets `posting` and finalizes —
      // otherwise both `wait` and the browser hang until the session times out.
      return (async () => {
        try {
          const { repo, pr } = api.repoAndPr();
          for (const r of replies) {
            try {
              let text = r.body.trim();
              // Opt-in committable suggestion: append the payload's server-side
              // `suggestion` (never client-supplied) as a ```suggestion block, so
              // the reviewer can accept the agent's exact fix from the PR. Only
              // for review threads (a suggestion is anchored to a diff range).
              if (r.asSuggestion === true && r.kind === 'review') {
                const thread = (st.replyPayload.reviewThreads || []).find((t) => t.id === r.threadId);
                const suggestion = thread && typeof thread.suggestion === 'string' ? thread.suggestion : null;
                if (suggestion != null) {
                  const block = '```suggestion\n' + suggestion.replace(/\n+$/, '') + '\n```';
                  text = text ? `${text}\n\n${block}` : block;
                }
              }
              if (config.signature) text += `\n\n${config.signature}`;
              st.itemStatus[r.key] = { status: 'posting', attempt: 1 };
              recordEvent('post_item', { key: r.key, kind: r.kind, path: r.path, line: r.line, status: 'posting', attempt: 1 });
              const onAttempt = (attempt, error) => {
                st.itemStatus[r.key] = { status: 'retrying', attempt, error };
                recordEvent('post_item', { key: r.key, kind: r.kind, status: 'retrying', attempt, error });
              };
              const out = r.kind === 'review'
                ? await prov.postReviewReply(
                    { repo, pr, threadId: r.threadId, replyToDatabaseId: r.replyToDatabaseId, body: text }, onAttempt)
                : await prov.postIssueComment({ repo, pr, body: text }, onAttempt);
              if (out.ok) {
                postedKeys.add(r.key);
                results.errors = results.errors.filter((e) => e.key !== r.key);
                results.posted.push({ kind: r.kind, key: r.key, path: r.path, line: r.line, url: out.url, variant: r.variant });
                st.itemStatus[r.key] = { status: 'posted', url: out.url };
                recordEvent('post_item', { key: r.key, kind: r.kind, path: r.path, line: r.line, status: 'posted', url: out.url, variant: r.variant });
                log(`posted ${r.kind} reply${r.path ? ` (${r.path}:${r.line ?? '?'})` : ''}`);
                const thread = (st.replyPayload.reviewThreads || []).find((t) => t.id === r.threadId);
                if (r.kind === 'review' && r.resolve === true && thread && thread.viewerCanResolve) {
                  // Full arg bag: GitHub resolves by global thread node id and
                  // ignores the rest; GitLab needs repo + MR iid + discussion id.
                  const res = await prov.resolveThread(
                    { repo, pr, threadId: r.threadId, replyToDatabaseId: r.replyToDatabaseId }, onAttempt);
                  if (res.ok) {
                    results.resolved.push({ key: r.key, threadId: r.threadId });
                    recordEvent('resolve_item', { key: r.key, status: 'resolved' });
                  } else {
                    results.resolveErrors.push({ key: r.key, threadId: r.threadId, error: res.error });
                    recordEvent('resolve_item', { key: r.key, status: 'failed', error: res.error });
                  }
                }
              } else {
                recordItemFailure(r, out.error);
                log(`FAILED ${r.kind} reply: ${out.error}`);
              }
            } catch (e) {
              // A provider is documented never to throw, but resolveThread, the
              // payload lookup, or appendEvent still can. Turn it into a normal
              // per-item failure instead of stranding the session.
              const msg = e && e.message ? e.message : String(e);
              recordItemFailure(r, msg);
              log(`FAILED ${r.kind} reply (unexpected): ${msg}`);
            }
          }
        } catch (e) {
          // Something outside per-item handling threw (e.g. repo/pr resolution).
          // Don't strand the session — fall through to the terminal logic below.
          log(`posting loop aborted: ${e && e.message ? e.message : e}`);
        } finally {
          st.posting = false;
          const failed = currentFailed().length;
          try {
            recordEvent('post_done', { posted: results.posted.length, failed, skipped: results.skipped.length });
          } catch (_) { /* event log unwritable */ }
          notifyChange();
          // Terminal only when nothing is outstanding. Partial failures keep
          // phase=reply so the browser can Retry failed / Finish anyway.
          if (failed === 0) finalizeReply('submitted', 'done');
        }
      })();
    },

    finishReply() {
      if (st.phase !== 'reply') throw httpError(409, `cannot finish in phase ${st.phase}`);
      if (st.posting) throw httpError(409, 'posting in progress');
      finalizeReply('submitted', 'done');
    },

    // Opt-in single roll-up comment on the PR/MR, posted via the same path as
    // any reply. Idempotent: at most one per session — a recorded summary_posted
    // event (which survives resume) short-circuits a repeat call.
    async postSummary() {
      if (st.phase === 'cancelled') throw httpError(409, 'session was cancelled');
      if (!anyPayload()) throw httpError(409, 'no PR context for a summary');
      const prior = st.events.find((e) => e.type === 'summary_posted');
      if (prior) return { ok: true, url: prior.url, already: true };
      const { repo, pr } = api.repoAndPr();
      let body = buildSummaryBody();
      if (config.signature) body += `\n\n${config.signature}`;
      const out = await prov.postIssueComment({ repo, pr, body });
      if (!out || !out.ok) throw httpError(502, `summary comment failed: ${(out && out.error) || 'unknown'}`);
      recordEvent('summary_posted', { url: out.url });
      notifyChange();
      return { ok: true, url: out.url };
    },

    stop(reason) { terminate(reason === 'timeout' ? 'timeout' : 'cancelled', reason); },

    // Best-effort sidecar mirroring the browser's in-progress assignee/decision
    // drafts. Never read by the phase machine; just a durable copy.
    saveDecisionsDraft(obj) {
      writeAtomic(paths.decisionsDraft, Object.assign({ version: 1, savedAt: new Date().toISOString() }, obj && typeof obj === 'object' ? obj : {}));
    },

    snapshot() {
      const p = anyPayload();
      return {
        mode: 'session',
        phase: st.phase,
        posting: st.posting,
        abortRequested: st.abortRequested,
        noPost: !!flags.noPost,
        provider: providerName(p),
        host: providerHost(p),
        repo: p ? p.repo : null,
        pr: p ? p.pr : null,
        config: {
          signature: config.signature || '',
          autoResolveFixedThreads: config.autoResolveFixedThreads !== false,
          defaultTriageAction: config.defaultTriageAction || null,
          theme: config.theme || 'system',
          agentLabel: config.agentLabel || null,
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
