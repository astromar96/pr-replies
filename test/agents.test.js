'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generate, root } = require('../scripts/build-agents.js');
const { install } = require('../scripts/install-codex.js');

function byPath() {
  const map = {};
  for (const o of generate()) map[path.relative(root, o.path)] = o.content;
  return map;
}

test('build-agents emits both runners for every workflow source', () => {
  const map = byPath();
  for (const name of ['pr-replies', 'pr-dashboard']) {
    assert.ok(map[`commands/${name}.md`], `missing Claude command for ${name}`);
    assert.ok(map[`.agents/skills/${name}/SKILL.md`], `missing Codex skill for ${name}`);
  }
});

test('generated files on disk match build-agents output (no drift)', () => {
  for (const o of generate()) {
    const rel = path.relative(root, o.path);
    const actual = fs.readFileSync(o.path, 'utf8');
    assert.equal(actual, o.content, `${rel} is out of sync — run "npm run build:agents"`);
  }
});

test('Claude commands keep ${CLAUDE_PLUGIN_ROOT}/$ARGUMENTS and leak no Codex tokens', () => {
  const map = byPath();
  for (const name of ['pr-replies', 'pr-dashboard']) {
    const c = map[`commands/${name}.md`];
    assert.match(c, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${name}: lost CLAUDE_PLUGIN_ROOT`);
    assert.doesNotMatch(c, /PR_REPLIES_HOME/, `${name}: leaked PR_REPLIES_HOME`);
    assert.doesNotMatch(c, /\{\{ROOT\}\}|\{\{ARGS\}\}/, `${name}: unexpanded token`);
  }
  // $ARGUMENTS only appears where the source has {{ARGS}} (pr-replies, not the
  // argument-less dashboard).
  assert.match(map['commands/pr-replies.md'], /Arguments: "\$ARGUMENTS"/);
});

test('Codex skills use ${PR_REPLIES_HOME}, require name+description, leak no Claude tokens', () => {
  const map = byPath();
  for (const name of ['pr-replies', 'pr-dashboard']) {
    const s = map[`.agents/skills/${name}/SKILL.md`];
    const fm = s.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `${name}: skill missing frontmatter`);
    assert.match(fm[1], new RegExp(`(^|\\n)name: ${name}(\\n|$)`), `${name}: skill missing name`);
    assert.match(fm[1], /(^|\n)description: \S/, `${name}: skill missing description`);
    assert.doesNotMatch(s, /CLAUDE_PLUGIN_ROOT/, `${name}: skill leaked CLAUDE_PLUGIN_ROOT`);
    assert.doesNotMatch(s, /\$ARGUMENTS/, `${name}: skill leaked $ARGUMENTS`);
    assert.doesNotMatch(s, /\{\{ROOT\}\}|\{\{ARGS\}\}/, `${name}: unexpanded token`);
  }
  assert.match(map['.agents/skills/pr-replies/SKILL.md'], /\$\{PR_REPLIES_HOME\}\/server\/server\.js/);
});

test('install-codex bakes this checkout path as the PR_REPLIES_HOME fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-codex-'));
  try {
    const written = install({ dir });
    assert.equal(written.length, 2);
    const skill = fs.readFileSync(path.join(dir, 'pr-replies', 'SKILL.md'), 'utf8');
    // env var still wins, baked path is the fallback — and no bare ${PR_REPLIES_HOME} remains.
    assert.match(skill, new RegExp('\\$\\{PR_REPLIES_HOME:-' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}'));
    assert.doesNotMatch(skill, /\$\{PR_REPLIES_HOME\}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
