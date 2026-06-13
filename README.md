# pr-replies

A [Claude Code](https://code.claude.com) plugin that turns PR review feedback
into **one live browser session** instead of terminal back-and-forth:

1. **Triage** — Claude fetches the PR's unresolved review threads and general
   comments, reads your code, and proposes a per-comment plan (with a
   confidence badge and, for high-confidence fixes, a sketched diff). In the
   browser you choose **Fix / Reply only / Skip** per comment — keyboard-first
   (`j`/`k`, `1`/`2`/`3`, `⌘↩`), with filtering, batch actions, and file
   grouping for big PRs.
2. **Fix (live)** — the same tab switches to a progress view while Claude
   implements the approved fixes: per-fix status, test checks, commit SHAs and
   the push, streamed in real time. An **Abort** button hands control back at
   any point.
3. **Reply** — the tab switches to Claude's drafts. Each card shows the
   **actual fix commit diff** (read from git, not from Claude's memory), a
   markdown preview toggle, and a **Resolve thread** checkbox. Hit Send — the
   local server posts via `gh` with rate-limit retries, resolves the threads
   you ticked, and streams per-item status back to the page. Partial failures
   stay on screen with **Retry failed / Finish anyway**.

Everything runs locally on `127.0.0.1` behind a random URL token. The only
network calls are `gh` talking to GitHub with your existing auth. Your edits
survive refreshes, timeouts, and even a server restart (localStorage keyed by
repo + PR, and a resumable on-disk session).

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth login`)
- Node.js 18+ (no npm packages — server and UI are dependency-free, no build step)
- macOS, Linux, or Windows (browser launch uses `open` / `xdg-open` / `start`)

## Install

```
/plugin marketplace add astromar96/pr-replies
/plugin install pr-replies@pr-replies
```

## Use

In any repo with an open PR:

```
/pr-replies                       # autodetect the PR from the current branch
/pr-replies 42                    # PR number in the current repo
/pr-replies https://github.com/owner/repo/pull/42
/pr-replies --no-fix              # skip triage/fixes, go straight to replying
/pr-replies --dry-run             # full flow, but nothing is posted to GitHub
/pr-replies --allow-cross-repo    # allow fixes on a fork PR you have checked out
```

Only **unresolved** review threads are shown. Comments you authored and bot
comments are filtered out of the general-comments list.

## Configuration (optional)

`~/.config/pr-replies/config.json`:

```json
{
  "signature": "",
  "defaultTriageAction": null,
  "autoResolveFixedThreads": true,
  "sessionTimeoutMins": 120,
  "waitTimeoutSecs": 540
}
```

- `signature` — appended to every posted reply (server-side; the UI shows a note).
- `defaultTriageAction` — preselected action when Claude has no suggestion (`"fix"`, `"reply"`, `"skip"`).
- `autoResolveFixedThreads` — pre-tick "Resolve thread" on fixed threads you can resolve.
- `sessionTimeoutMins` — how long the background session server lives without finishing.
- `waitTimeoutSecs` — default window for each blocking `wait` call.

## How it works

```
Claude (skill)                       server (background)                browser (one tab)
write triage.payload.json
serve --session DIR  ──────────────▶ boots, opens /{token}/       ◀──▶  triage view
wait --phase triage  (blocks)        user submits → phase=fixing  ───▶  progress view
emit --type fix_done … ────────────▶ events.jsonl → SSE           ───▶  live fix timeline
write reply.payload.json
advance --phase reply ─────────────▶ validates, attaches git diffs ──▶  reply view
wait --phase reply   (blocks)        posts via gh (retry+resolve) ───▶  per-item status
stop --session DIR
```

- `commands/pr-replies.md` instructs Claude through the 11-step flow.
- `server/server.js` is a five-subcommand CLI (`serve` / `wait` / `emit` /
  `advance` / `stop`) over zero-dependency libs in `server/lib/`. The session
  state machine (`triage → fixing → reply → done|cancelled`) persists
  everything in a session dir under `/tmp/pr-replies/`; all JSON is written
  atomically and `events.jsonl` doubles as the SSE replay log, so a refresh or
  reconnect never loses state.
- `server/ui/` is a vanilla-JS single page (concatenated at serve time — no
  build step) that boots from `GET /state` and listens on `GET /events` (SSE).
  No payload is ever injected into the HTML.
- Inline replies land **inside the review thread** (GraphQL
  `addPullRequestReviewThreadReply`, REST fallback); general comments post as
  new top-level PR comments; ticked threads are resolved with
  `resolveReviewThread` (failures are non-fatal and reported).

## Timeouts & resume

Each `wait` call blocks for up to 9 minutes (under Claude Code's 10-minute
Bash limit), but **the session does not end with it** — Claude simply re-runs
`wait` and the tab is untouched. The background server itself lives for
`sessionTimeoutMins` (default 2 h). If the server dies, Claude relaunches it
with `serve --resume`: state is rebuilt from the session dir (already-posted
replies stay locked), the browser reopens, and your in-browser edits are
restored from localStorage.

## Development

```
git clone https://github.com/astromar96/pr-replies
claude --plugin-dir ./pr-replies
```

Run the test suite (Node's built-in runner):

```
npm test          # = node --test test/
```

Drive the full session UI without GitHub or Claude:

```
scripts/demo.sh              # triage → scripted fix progress → dry-run replies
scripts/demo.sh reply-only   # the --no-fix fast path
```

To exercise crash recovery: kill the `serve` pid mid-triage, then
`node server/server.js serve --session <dir> --resume`.

## License

MIT
