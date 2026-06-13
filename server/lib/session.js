'use strict';

/**
 * Session directory layer. The server is the single writer of everything in
 * the session dir except the two payload files (written by Claude and read
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
    eventsLog: path.join(dir, 'events.jsonl'),
  };
}

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
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
