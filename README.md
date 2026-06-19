# pr-replies

A [Claude Code](https://code.claude.com) plugin that turns **GitHub PR** and
**GitLab MR** review feedback into **one live browser session** instead of
terminal back-and-forth:

1. **Triage** — Claude fetches the PR/MR's unresolved review threads (GitHub) or
   MR discussions (GitLab) and general comments, reads your code, and proposes a
   per-comment plan (with a confidence badge and, for high-confidence fixes, a
   sketched diff). Suggestions are informed by this repo's history — what past
   feedback you fixed vs replied to. In the browser you choose
   **Fix / Reply only / Skip** per comment — keyboard-first (`j`/`k`, `1`/`2`/`3`,
   `⌘↩`), with filtering, batch actions, and file grouping for big PRs.
2. **Fix (live)** — the same tab switches to a progress view while Claude
   implements the approved fixes: per-fix status, test checks, commit SHAs and
   the push, streamed in real time. An **Abort** button hands control back at
   any point.
3. **Reply** — the tab switches to Claude's drafts. For each comment Claude
   writes **two reply variants** — a **Direct / fix-plan** draft ("I'll apply
   the fix by …") and a warmer **Humanized** draft — shown side by side; pick
   one (`v` toggles), then tweak it. Each card also shows the **actual fix
   commit diff** (read from git, not from Claude's memory), a markdown preview
   toggle, and a **Resolve thread** checkbox. Hit Send — the local server posts
   via `gh`/`glab` with rate-limit retries, resolves the threads you ticked, and
   streams per-item status back to the page. Partial failures stay on screen
   with **Retry failed / Finish anyway**.

Everything runs locally on `127.0.0.1` behind a random URL token. The only
network calls are the `gh`/`glab` CLI talking to GitHub/GitLab with your
existing auth — **the tool never handles tokens**; authentication is delegated
entirely to whichever CLI your repo uses. Your edits survive refreshes,
timeouts, and even a server restart (localStorage keyed by repo + PR, and a
resumable on-disk session).

The whole session lives inside an **app shell** with a persistent nav
(**Active PR · History · Templates**), a **light / dark / system** theme toggle,
and keyboard-first navigation throughout (`g h` / `g t` / `g p` jump between
routes). Triage and reply can be **grouped by file or by reviewer**, and each
comment can be tagged with a teammate to handle — see
[The hub](#the-hub--history--templates) below.

## Requirements

- For GitHub: [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth login`)
- For GitLab: [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) installed and authenticated (`glab auth login`; for a self-managed instance, `glab auth login --hostname your.gitlab.host`)
- Node.js 18+ (no install, no build step — the React UI ships as vendored static files and is served unbundled)
- macOS, Linux, or Windows (browser launch uses `open` / `xdg-open` / `start`)

The provider is **auto-detected** from your git remote (github.com → GitHub,
gitlab.com or any self-managed `gitlab.*` host → GitLab); override with
`--provider` / `--host` when it can't be inferred.

## Install

```
/plugin marketplace add astromar96/pr-replies
/plugin install pr-replies@pr-replies
```

## Use

In any repo with an open PR (GitHub) or MR (GitLab):

```
/pr-replies                       # autodetect the PR/MR from the current branch
/pr-replies 42                    # PR/MR number in the current repo
/pr-replies https://github.com/owner/repo/pull/42
/pr-replies https://gitlab.com/group/project/-/merge_requests/42
/pr-replies --no-fix              # skip triage/fixes, go straight to replying
/pr-replies --dry-run             # full flow, but nothing is posted
/pr-replies --allow-cross-repo    # allow fixes on a fork PR you have checked out
/pr-replies --provider gitlab     # force the provider (else auto-detected)
/pr-replies --host gitlab.example.com   # self-managed GitLab host
```

Only **unresolved** threads/discussions are shown. Comments you authored and bot
comments are filtered out of the general-comments list.

## The hub — history & templates

These features make pr-replies feel like a team tool while staying **local —
each developer runs it on their own machine with their own `gh`/`glab` auth**.
There is no hosted server and no accounts.

Open the hub (no PR needed) to browse across sessions:

```
/pr-dashboard                            # the recommended way — opens the hub in your browser
node server/server.js serve --home       # or run it directly (npm run home)
```

- **History** — an audit log of every finished session (what was posted,
  resolved, and fixed, with commit SHAs and timestamps). Written automatically at
  the end of each session; nothing to enable. The hub lands here.
- **Templates** — reusable reply snippets. Press `t` while drafting a reply (or
  triage guidance) to insert one, with `{{author}}`, `{{sha}}`, `{{path}}`,
  `{{pr}}`, `{{repo}}`, and `{{line}}` filled in. Your templates live in
  `~/.config/pr-replies/templates.json`; a repo can also ship read-only shared
  templates in `.pr-replies/templates.json` (merged in, user wins on conflicts).
- **Reviewer routing** — group triage/reply by reviewer (with their review
  state), assign a comment to a teammate, and optionally @-mention them in the
  posted reply. Assignment is an advisory label + opt-in mention, not a GitHub
  assignment API call.

Local files the hub reads and writes (all under `~/.config/pr-replies/`):
`templates.json`, `history/<session>.json`, and `home.json` (the running hub's
address). Set `PR_REPLIES_CONFIG_DIR` to point all of these elsewhere — the test
suite and UI preview use it so they never touch your real files.

## Configuration (optional)

`~/.config/pr-replies/config.json`:

```json
{
  "signature": "",
  "defaultTriageAction": null,
  "autoResolveFixedThreads": true,
  "sessionTimeoutMins": 120,
  "waitTimeoutSecs": 540,
  "historyMax": 200,
  "theme": "system"
}
```

- `signature` — appended to every posted reply (server-side; the UI shows a note).
- `defaultTriageAction` — preselected action when Claude has no suggestion (`"fix"`, `"reply"`, `"skip"`).
- `autoResolveFixedThreads` — pre-tick "Resolve thread" on fixed threads you can resolve.
- `sessionTimeoutMins` — how long the background session server lives without finishing.
- `waitTimeoutSecs` — default window for each blocking `wait` call.
- `historyMax` — how many session records to keep in `history/` (oldest pruned; cap 2000).
- `theme` — `"light"`, `"dark"`, or `"system"`. The in-browser toggle overrides this per browser.

## How it works

```
Claude (skill)                       server (background)                browser (one tab)
write triage.payload.json
serve --session DIR  ──────────────▶ boots, opens /{token}/       ◀──▶  triage view
wait --phase triage  (blocks)        user submits → phase=fixing  ───▶  progress view
emit --type fix_done … ────────────▶ events.jsonl → SSE           ───▶  live fix timeline
write reply.payload.json
advance --phase reply ─────────────▶ validates, attaches git diffs ──▶  reply view
wait --phase reply   (blocks)        posts via gh/glab (retry+resolve) ▶  per-item status
stop --session DIR
```

- `commands/pr-replies.md` instructs Claude through the flow (Step 0 detects the
  provider; later steps branch between `gh` and `glab`). `commands/pr-dashboard.md`
  is a thin launcher for the hub.
- Provider backends live in `server/lib/providers/` behind a small factory
  (`createProvider`): `github.js` (`gh`) and `gitlab.js` (`glab`, REST-only)
  share a retry kernel and expose the same interface
  (`postReviewReply` / `postIssueComment` / `resolveThread` / `listPrs`). The rest
  of the server is provider-agnostic; `server/lib/github.js` remains as a
  back-compat shim.
- `server/server.js` is a CLI (`serve` / `wait` / `emit` / `advance` / `stop`,
  plus the read-only `suggest` helper) over zero-dependency libs
  in `server/lib/`. The session
  state machine (`triage → fixing → reply → done|cancelled`) persists
  everything in a session dir under `/tmp/pr-replies/`; all JSON is written
  atomically and `events.jsonl` doubles as the SSE replay log, so a refresh or
  reconnect never loses state.
- `serve --home` is the same server with no session: it skips the state machine
  and exposes only a read-only data plane (`GET /{token}/data/*`) backed by
  `server/lib/{dataPlane,store,history}.js` — live sessions, history, and
  templates, all read from local JSON. Phase routes 404 in this mode.
- `server/ui/` is a **React single page with no build step**. The vendored
  React + [htm](https://github.com/developit/htm) UMD bundles
  (`server/ui/vendor/`) and the app modules (`server/ui/app/`) are concatenated
  into one inline `<script>` at serve time — htm parses the JSX-free
  tagged-template markup at runtime, so there is nothing to compile or install.
  The app boots from `GET /state` and listens on `GET /events` (SSE); external
  stores (`app/stores.js`) bridge that state into React via
  `useSyncExternalStore`. A hash router in `app/App.js` layers the History /
  Templates routes over the per-PR phase views (`app/views/`). No payload is
  ever injected into the HTML.
- On **GitHub**, inline replies land **inside the review thread** (GraphQL
  `addPullRequestReviewThreadReply`, REST fallback), general comments post as
  new top-level PR comments, and ticked threads are resolved with
  `resolveReviewThread`. On **GitLab** the same operations map to MR discussion
  replies, top-level MR notes, and resolving a discussion (REST `PUT …?resolved=true`).
  Resolve failures are non-fatal and reported either way.

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
scripts/demo.sh home         # the history / templates hub
```

`npm run ui:preview` boots the real server (session **and** hub) and drives the
whole UI with Playwright, screenshotting every route into `test/ui/screenshots/`.
Because the entire React bundle is concatenated and served, it doubles as an
integration test: any load-order, render, or `ReferenceError` regression makes a
route throw (a page error the harness fails on).

To exercise crash recovery: kill the `serve` pid mid-triage, then
`node server/server.js serve --session <dir> --resume`.

## License

MIT
