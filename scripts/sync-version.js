#!/usr/bin/env node
'use strict';

// Copy the package.json version into .claude-plugin/plugin.json so the
// marketplace manifest stays in lockstep with the package version.
// Runs automatically as part of `npm version` (see the "version" script in
// package.json); can also be run on its own with `npm run sync:version`.
//
// Edits the manifest as text rather than re-serializing it, so the file's
// existing formatting (single-line keywords array, key order) is preserved.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const pluginPath = path.join(root, '.claude-plugin', 'plugin.json');

let text = fs.readFileSync(pluginPath, 'utf8');
JSON.parse(text); // fail loudly if the manifest is already malformed

if (/"version"\s*:/.test(text)) {
  text = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
} else {
  // No version field yet: insert one right after the top-level "name" field,
  // matching its indentation.
  text = text.replace(
    /^(\s*)("name"\s*:\s*"[^"]*",)\s*$/m,
    `$1$2\n$1"version": "${version}",`
  );
}

const parsed = JSON.parse(text);
if (parsed.version !== version) {
  console.error(`sync-version: failed to set plugin.json version to ${version}`);
  process.exit(1);
}

fs.writeFileSync(pluginPath, text);
console.log(`sync-version: .claude-plugin/plugin.json version -> ${version}`);
