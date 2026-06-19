#!/usr/bin/env node
'use strict';

// Install the pr-replies skills for OpenAI Codex (and any runner that reads the
// open agent-skills standard from ~/.agents/skills). Copies each generated
// .agents/skills/<name>/SKILL.md into the user's skills dir and bakes THIS
// checkout's absolute path in as the fallback for ${PR_REPLIES_HOME}, so the
// skill runs from any repo with no extra setup. The env var still wins when
// set. Re-run after `git pull` to pick up workflow changes.
//
// Usage: node scripts/install-codex.js [--dir <skills-dir>] [--dry-run]
//   --dir      install location (default: ~/.agents/skills)
//   --dry-run  print what would be written without touching the filesystem

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SRC = path.join(root, '.agents', 'skills');

function parseArgs(argv) {
  const out = { dir: path.join(os.homedir(), '.agents', 'skills'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      const v = argv[++i];
      if (!v) { console.error('--dir requires a path'); process.exit(1); }
      out.dir = path.resolve(v);
    } else if (argv[i] === '--dry-run') {
      out.dryRun = true;
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return out;
}

function install({ dir, dryRun } = {}) {
  if (!fs.existsSync(SRC)) {
    throw new Error(`no generated skills at ${SRC} — run "npm run build:agents" first`);
  }
  const names = fs.readdirSync(SRC).filter((n) => fs.existsSync(path.join(SRC, n, 'SKILL.md')));
  if (!names.length) throw new Error(`no SKILL.md bundles under ${SRC}`);

  // ${PR_REPLIES_HOME} → ${PR_REPLIES_HOME:-<checkout>} (shell default-expansion):
  // env var wins when set, baked path otherwise.
  const baked = '${PR_REPLIES_HOME:-' + root + '}';
  const written = [];
  for (const name of names) {
    const content = fs.readFileSync(path.join(SRC, name, 'SKILL.md'), 'utf8')
      .split('${PR_REPLIES_HOME}').join(baked);
    const destFile = path.join(dir, name, 'SKILL.md');
    if (dryRun) {
      console.log(`[dry-run] would write ${destFile}`);
    } else {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, content);
      console.log(`installed ${name} → ${destFile}`);
    }
    written.push(destFile);
  }
  return written;
}

module.exports = { install, root, SRC };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    install(opts);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!opts.dryRun) {
    console.log('');
    console.log('Done. In Codex the skills are available as $pr-replies and $pr-dashboard');
    console.log('(or browse them with /skills). Codex may also invoke pr-replies implicitly');
    console.log('when you ask it to reply to PR/MR review comments.');
    console.log('');
    console.log(`Keep this checkout in place — the skills run its server from:\n  ${root}`);
    console.log('Set PR_REPLIES_HOME to override that path if you move the checkout.');
  }
}
