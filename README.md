# pr-replies

A [Claude Code](https://code.claude.com) plugin that turns PR review feedback
into a three-step flow, with the human parts in a **local browser UI** instead
of the terminal:

1. **Triage** — Claude fetches the PR's unresolved review threads and general
   comments, reads your code, and proposes a per-comment plan. A browser UI
   opens where you choose **Fix / Reply only / Skip** per comment and add
   optional guidance.
2. **Fix** — Claude implements the approved fixes, commits one commit per
   logical fix, and pushes to the PR branch.
3. **Reply** — a second browser UI opens with Claude's reply drafts pre-filled
   (fixed items reference the real commit SHAs). You edit/approve each one,
   hit **Send**, and the local server posts them to GitHub via `gh`.

Everything runs locally. The only network calls are `gh` talking to GitHub
with your existing auth.

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth login`)
- Node.js 18+ (no npm packages — the server is dependency-free)
- macOS (`open` is used to launch the browser; on Linux replace with `xdg-open` in `server/server.js`)

## Install

```
/plugin marketplace add astromar96/pr-replies
/plugin install pr-replies@pr-replies
```

## Use

In any repo with an open PR:

```
/pr-replies              # autodetect the PR from the current branch
/pr-replies 42           # PR number in the current repo
/pr-replies https://github.com/owner/repo/pull/42
/pr-replies --no-fix     # skip triage/fixes, go straight to replying
```

Only **unresolved** review threads are shown. Comments you authored and bot
comments are filtered out of the general-comments list.

## How it works

- `commands/pr-replies.md` instructs Claude to fetch threads (GraphQL
  `reviewThreads`, unresolved only), propose per-comment fix plans, write a
  payload JSON to `/tmp`, and launch the bundled server.
- `server/server.js` (zero-dependency Node) serves `server/ui.html` on
  `127.0.0.1` with a random URL token, blocks until you submit, posts replies
  via `gh api` (GraphQL `addPullRequestReviewThreadReply`, REST fallback), and
  prints a result JSON block to stdout that flows back into Claude's context.
- Inline replies land **inside the review thread**; replies to general
  comments post as new top-level PR comments (GitHub has no threading there).

## Timeouts

Each browser session has a 9-minute window: the command launches the server
with `--timeout-secs 540` so it exits cleanly with a `timeout` status before
Claude Code's default 10-minute Bash limit kills it. If you need longer, raise
the Bash limit (`BASH_MAX_TIMEOUT_MS` in your Claude Code settings env) and
ask Claude for a longer window — the command instructs it to scale
`--timeout-secs` to the Bash limit minus 60 s. After a timeout Claude can
always relaunch the UI with the same payload, which persists in `/tmp`.

## Development

```
git clone https://github.com/astromar96/pr-replies
claude --plugin-dir ./pr-replies
```

Iterate on the UI without GitHub or Claude:

```
node server/server.js --payload examples/payload.triage.json --no-post --timeout-secs 600
node server/server.js --payload examples/payload.reply.json  --no-post --timeout-secs 600
```

`--no-post` makes reply-mode submits dry-run (no GitHub writes). The result
JSON block is printed to stdout on submit/cancel/timeout.

## License

MIT
