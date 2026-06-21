'use strict';

/**
 * Session directory layer. The server is the single writer of everything in
 * the session dir except the two payload files (written by the agent and read
 * only on explicit triggers — serve boot / advance — never watched).
 *
 * All JSON goes through write-to-tmp + rename so readers (`wait` polling for
 * result files) can never observe a partial write. events.jsonl is append-only
 * with one whole line per write().
 */

const fs = require('node:fs');
const path = require('node:path');

function sessionPaths(dir) {
  return {
    dir,
    sessionFile: path.join(dir, 'session.json'),
    triagePayload: path.join(dir, 'triage.payload.json'),
    triageResult: path.join(dir, 'triage.result.json'),
    replyPayload: path.join(dir, 'reply.payload.json'),
    replyResult: path.join(dir, 'reply.result.json'),
    decisionsDraft: path.join(dir, 'decisions.draft.json'),
    eventsLog: path.join(dir, 'events.jsonl'),
  };
}

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  // Write + fsync the tmp file before renaming, then best-effort fsync the
  // directory. The wait/resume contract treats the result files as the durable
  // source of truth, so the worst case is a reply that landed on GitHub but
  // whose result the session can't prove after a crash/power-loss. rename is
  // atomic against torn content but does not by itself guarantee the bytes (or
  // the rename) reached disk — fsync closes that window.
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (_) { /* some platforms/filesystems reject directory fsync — best effort */ }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function appendEvent(dir, event) {
  fs.appendFileSync(sessionPaths(dir).eventsLog, JSON.stringify(event) + '\n');
}

function readEvents(dir, afterSeq = 0) {
  let raw;
  try {
    raw = fs.readFileSync(sessionPaths(dir).eventsLog, 'utf8');
  } catch (_) {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.seq > afterSeq) events.push(e);
    } catch (_) { /* torn final line from a crashed writer */ }
  }
  return events;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = { sessionPaths, writeAtomic, readJson, appendEvent, readEvents, isPidAlive };
