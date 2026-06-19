#!/usr/bin/env node
'use strict';

// CI guard: the marketplace manifest version (.claude-plugin/plugin.json) must
// match package.json, which is the single source of truth. They are kept in
// sync by `npm version` / `npm run sync:version`; this check fails the build if
// they ever drift (e.g. someone hand-edited one of them).

const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const plugin = require(path.join(root, '.claude-plugin', 'plugin.json'));

if (plugin.version !== pkg.version) {
  console.error(
    `version mismatch: package.json=${pkg.version} but ` +
      `.claude-plugin/plugin.json=${plugin.version}\n` +
      'Run "npm run sync:version" (or "npm version <patch|minor|major>") to reconcile them.'
  );
  process.exit(1);
}

console.log(`version OK: ${pkg.version} (package.json == plugin.json)`);
