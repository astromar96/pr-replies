#!/usr/bin/env node
'use strict';

// CI guard: the generated runner files (commands/*.md and
// .agents/skills/*/SKILL.md) must match what build-agents.js produces from
// src/agent/*.workflow.md. Fails the build if anyone hand-edited a generated
// file or forgot to run `npm run build:agents` after editing a source.

const fs = require('node:fs');
const path = require('node:path');
const { generate, root } = require('./build-agents');

let drift = 0;
for (const o of generate()) {
  const rel = path.relative(root, o.path);
  let actual = null;
  try { actual = fs.readFileSync(o.path, 'utf8'); } catch (_) { /* missing */ }
  if (actual !== o.content) {
    drift++;
    console.error(actual === null ? `missing: ${rel}` : `drift: ${rel} is out of sync with its src/agent source`);
  }
}

if (drift) {
  console.error(`\n${drift} generated file(s) out of date. Run "npm run build:agents" and commit the result.`);
  process.exit(1);
}
console.log('agents OK: commands/ and .agents/skills/ match src/agent/');
