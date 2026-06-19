# AGENTS.md — pr-replies

Agent-neutral guide for any coding agent (OpenAI Codex, Claude Code, …) working
**on this repository**. End users don't need this file; it documents how the
tool is built and run so an agent can contribute safely.

## What this is

`pr-replies` turns GitHub PR / GitLab MR review feedback into one live,
keyboard-first **browser session**: triage → fix → reply. A thin agent workflow
drives a zero-dependency Node server that hosts the UI and posts replies via the
user's `gh` / `glab` CLI (the tool never handles tokens).

## How it runs (two runners, one core)

- **Shared core:** `server/server.js` — a stdlib-only CLI
  (`serve` / `wait` / `emit` / `advance` / `stop` / `suggest`). It locates its
  own files with `__dirname`, so it is install-location independent.
- **Claude Code:** the plugin slash commands in `commands/*.md` (use
  `${CLAUDE_PLUGIN_ROOT}` to find the checkout).
- **OpenAI Codex:** the skills in `.agents/skills/*/SKILL.md` (open agent-skills
  standard; use `${PR_REPLIES_HOME}` to find the checkout). Install with
  `node scripts/install-codex.js`.

## Single source — do NOT edit generated files

`commands/*.md` and `.agents/skills/*/SKILL.md` are **generated**. Edit the
agent-neutral sources and regenerate:

- Source: `src/agent/pr-replies.workflow.md`, `src/agent/pr-dashboard.workflow.md`
  - `{{ROOT}}` → the checkout root (per-runner env var)
  - `{{ARGS}}` → how invocation arguments reach the agent
- `npm run build:agents` regenerates both runners; `npm run check:agents` fails
  CI if a generated file drifts from its source.

## Conventions

- **Zero runtime dependencies.** Node 18+ stdlib only; Playwright is the lone
  dev dependency (UI preview). Don't add runtime deps.
- **No build step for the UI.** `server/ui/` is vendored React + htm,
  concatenated at serve time.
- **Agent-neutral copy.** Don't hard-code a specific agent's name in the server,
  UI, or workflow. The UI shows `config.agentLabel` (default: "the agent").
- The marketplace manifests under `.claude-plugin/` are Claude-Code-specific and
  correct as-is; `package.json` is the single source of truth for the version
  (synced into `plugin.json` by `scripts/sync-version.js`).

## Before you open a PR

```
npm test            # Node's built-in runner — no network needed
npm run check:agents
npm run check:version
npm run ui:preview   # boots the server + drives every route with Playwright
```
