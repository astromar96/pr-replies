#!/usr/bin/env node
'use strict';

// Generate the per-runner command/skill files from the single agent-neutral
// source in src/agent/*.workflow.md. One source produces:
//   - commands/<name>.md            — Claude Code plugin slash command
//   - .agents/skills/<name>/SKILL.md — OpenAI Codex skill (open agent-skills std)
//
// The runners differ only in their frontmatter and in two body tokens:
//   {{ROOT}} — the pr-replies checkout root (env var per runner)
//   {{ARGS}} — how the invocation arguments reach the agent
// Everything else (the ~400-line workflow) stays identical, so the two runners
// can never drift. `check-agents.js` re-runs generate() and fails CI on drift,
// exactly like sync-version.js / check-version.js do for the manifest version.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SRC_DIR = path.join(root, 'src', 'agent');

const TARGETS = {
  claude: {
    keys: ['description', 'argument-hint', 'allowed-tools'],
    tokens: { ROOT: '${CLAUDE_PLUGIN_ROOT}', ARGS: '"$ARGUMENTS"' },
    outPath: (name) => path.join(root, 'commands', `${name}.md`),
  },
  codex: {
    keys: ['name', 'description'],
    tokens: {
      ROOT: '${PR_REPLIES_HOME}',
      ARGS: 'the PR/MR number-or-URL and any flags the user included in their message.',
    },
    outPath: (name) => path.join(root, '.agents', 'skills', name, 'SKILL.md'),
  },
};

function parseSource(file, text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing "---" frontmatter block`);
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!kv) throw new Error(`${file}: unparseable frontmatter line: ${line}`);
    frontmatter[kv[1]] = kv[2];
  }
  if (!frontmatter.name) throw new Error(`${file}: frontmatter is missing "name"`);
  return { frontmatter, body: m[2] };
}

function renderTarget(file, src, target) {
  const t = TARGETS[target];
  const fmLines = t.keys.map((k) => {
    if (!(k in src.frontmatter)) throw new Error(`${file}: frontmatter is missing "${k}" (needed for ${target})`);
    return `${k}: ${src.frontmatter[k]}`;
  });
  let body = src.body;
  for (const [tok, val] of Object.entries(t.tokens)) body = body.split(`{{${tok}}}`).join(val);
  return `---\n${fmLines.join('\n')}\n---\n${body}`;
}

// Pure: returns [{ path, content }] for every generated file. Used by both the
// writer below and check-agents.js (which compares against what is on disk).
function generate() {
  const outputs = [];
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.workflow.md')).sort();
  if (!files.length) throw new Error(`no *.workflow.md sources in ${SRC_DIR}`);
  for (const f of files) {
    // Normalize CRLF so the parser and the LF-only generated output are stable
    // even if a source is checked out / edited with Windows line endings.
    const text = fs.readFileSync(path.join(SRC_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    const src = parseSource(f, text);
    for (const target of Object.keys(TARGETS)) {
      outputs.push({ path: TARGETS[target].outPath(src.frontmatter.name), content: renderTarget(f, src, target) });
    }
  }
  return outputs;
}

function build() {
  for (const o of generate()) {
    fs.mkdirSync(path.dirname(o.path), { recursive: true });
    fs.writeFileSync(o.path, o.content);
    console.log(`build:agents: wrote ${path.relative(root, o.path)}`);
  }
}

module.exports = { generate, build, root, TARGETS };

if (require.main === module) build();
