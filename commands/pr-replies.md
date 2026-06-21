---
description: Triage, fix, and reply to GitHub PR or GitLab MR comments in a live browser session
argument-hint: "[pr-or-mr-number-or-url] [--no-fix] [--allow-cross-repo] [--dry-run] [--provider github|gitlab] [--host HOST]"
allowed-tools: Bash(gh:*), Bash(glab:*), Bash(git:*), Bash(node:*), Bash(rm:*), Bash(date:*), Bash(mkdir:*), Bash(ls:*), Read, Grep, Glob, Edit, Write
---

<!-- GENERATED FILE — edit src/agent/pr-replies.workflow.md and run
`npm run build:agents`. Do not edit the generated commands/SKILL files directly. -->

# Reply to PR/MR comments via a live browser session

You will fetch this PR's (GitHub) or MR's (GitLab) unresolved feedback, then run
ONE browser session that spans the whole flow: the user triages in the browser →
you implement the approved fixes while the browser shows live progress → the user
reviews and sends the replies from the same tab. Follow these steps exactly.

This command works against **GitHub** (via the `gh` CLI) and **GitLab** (via the
`glab` CLI). Authentication is delegated entirely to whichever CLI the repo uses —
this tool never handles tokens. The provider is auto-detected from the git remote
(Step 0) and threaded through every step; where a step differs, the GitHub and
GitLab branches are shown explicitly. "Review thread" (GitHub) and "MR discussion"
(GitLab) are the same provider-neutral concept; likewise "issue comment" / "MR
note".

**Never post any comment yourself with `gh`/`glab`** — all posting happens
inside the session server during Step 10.

The server runs in the **background** for the whole session
(`server.js serve`). You block per phase with the foreground `server.js wait`
command, which is safe to re-run after a timeout — the server and the browser
tab survive between waits. You report fix progress to the browser with
`server.js emit` and hand over the reply drafts with `server.js advance`.

Arguments: "$ARGUMENTS"
- `--no-fix`: skip triage and fixes (Steps 7–9); reply-only session.
- `--allow-cross-repo`: allow fixes for a fork PR when the local checkout IS
  that fork (see Step 2).
- `--dry-run`: pass `--no-post` to the server; everything works but nothing is
  posted.
- `--provider github|gitlab`: force the provider instead of auto-detecting.
- `--host HOST`: the provider host for a self-managed instance (e.g.
  `gitlab.example.com`); auto-detected from the remote when omitted.

## Step 0 — Detect the provider

Determine PROVIDER and HOST (used by every later step):
1. If `--provider` is given, use it; if `--host` is given, use it.
2. Otherwise read the remote: `git -C <repo> remote get-url origin`. Classify
   the host — `github.com` (or any host containing `github`) → `github`;
   `gitlab.com` (or any host containing `gitlab`) → `gitlab`. Set HOST to that
   host. If the host matches neither, ask the user to pass `--provider`
   (and `--host` for a self-managed instance) and stop.

Everywhere below, run the `gh` branch when PROVIDER is `github` and the `glab`
branch when it is `gitlab`. For GitLab, a self-managed HOST is passed to every
`glab` call via the `GITLAB_HOST` environment variable
(e.g. `GITLAB_HOST=$HOST glab …`).

## Step 1 — Preflight

- **GitHub:** run `gh auth status`. If it fails, tell the user to run
  `gh auth login` and stop.
- **GitLab:** run `GITLAB_HOST=$HOST glab auth status`. If it fails, tell the
  user to run `glab auth login` (for a self-managed host,
  `glab auth login --hostname $HOST`) and stop.

## Step 2 — Resolve the PR / MR

Remove the known flags from the arguments; what remains (possibly nothing) is
the PR/MR argument.

**GitHub (PR):**
- URL `https://github.com/OWNER/REPO/pull/N` → parse OWNER, REPO, N. If that
  repo is not the current directory's repo: with `--allow-cross-repo`, check
  `gh pr view N --repo OWNER/REPO --json headRepositoryOwner,headRepository,headRefName`
  — if the local checkout's `origin` IS the PR's head fork and you are on
  `headRefName`, fixes are allowed; otherwise continue in reply-only mode
  (as if `--no-fix`), relying on each thread's `diffHunk` for context.
- Bare number → current repo (`gh repo view --json nameWithOwner`).
- Empty → autodetect with `gh pr view --json number,title,url,headRefName,author`;
  if that fails, ask the user for a PR number or URL and stop.
- Fetch the current user's login: `gh api user --jq .login` (call it SELF).

**GitLab (MR):**
- URL `https://HOST/GROUP/PROJECT/-/merge_requests/N` → parse the project path
  `GROUP/PROJECT` (nested groups allowed) and the MR IID `N`.
- Bare number → current project (`glab` infers it from the remote); read the
  project path from the `origin` remote.
- Empty → autodetect the MR for the current branch:
  `GITLAB_HOST=$HOST glab mr view --output json` (or
  `glab api "projects/<ENC>/merge_requests?source_branch=<BRANCH>&state=opened"`);
  if none, ask the user for an MR number or URL and stop.
- Fetch the current user: `GITLAB_HOST=$HOST glab api user --jq .username` (SELF).

Record REPO (the `owner/name` or `group/project` path), the number (PR number /
MR IID — call it N), and HOST. `<ENC>` below means REPO URL-encoded for the
GitLab REST API (every `/` becomes `%2F`).

**Resume check:** look for a live previous session:
`ls -d /tmp/pr-replies/*-pr<N>-* 2>/dev/null`. If a dir exists, read its
`session.json`; if `kill -0 <pid>` says the pid is alive, tell the user a
session is already running at its `url` and ask whether to resume (jump to the
`wait` for its current `phase`) or kill it (`server.js stop --session DIR --cleanup`)
and start fresh.

Unless reply-only: confirm the working tree is on the PR's head branch
(`git branch --show-current` vs `headRefName`; if different, `gh pr checkout N`).
Then `git status --porcelain` — if there are uncommitted changes, tell the user
fixes need a clean tree and stop. Record the absolute repo path as REPO_DIR.

## Step 3 — Fetch unresolved review threads / MR discussions

The goal is the same neutral list for either provider: each unresolved thread
records `id`, `isOutdated`, `viewerCanResolve`, `path`, `startLine`, `line`,
`replyToDatabaseId`, an optional `diffHunk`, and every comment's
author/createdAt/body (author flattened to a login/username string).

**GitHub** — run via `gh api graphql -f query='...' -F owner=OWNER -F name=REPO -F number=N`,
repeating with `-F cursor=<endCursor>` while `hasNextPage` (warn and stop
collecting past 200 threads):

```graphql
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title url author { login } headRefName
      reviews(last: 100) { nodes { author { login } state submittedAt } }
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated viewerCanResolve path startLine line
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { databaseId body author { login } createdAt diffHunk }
          }
        }
      }
    }
  }
}
```

Keep ONLY threads where `isResolved` is false. Per thread record: `id`,
`isOutdated`, `viewerCanResolve`, `path`, `startLine`, `line`, the FIRST
comment's `databaseId` (as `replyToDatabaseId`) and `diffHunk`, and every
comment's author/createdAt/body (flatten `author` to its `login` string).

If a thread's `comments.pageInfo.hasNextPage` is true (a single thread with more
than 100 comments — rare), note to the user that that thread is truncated to its
first 100 comments; still keep the FIRST comment as `replyToDatabaseId` (replies
attach to the thread, not to a specific later comment).

From `reviews`, compute `reviewers`: the latest non-`COMMENTED` review state
per login, as `[{login, state}]` (states like APPROVED / CHANGES_REQUESTED).

**GitLab** — fetch the MR discussions (paginate while there are more pages):

```
GITLAB_HOST=$HOST glab api "projects/<ENC>/merge_requests/N/discussions?per_page=100" --paginate
```

Keep ONLY discussions that have a note with `resolvable: true` AND
`resolved: false` (these are the unresolved threads; drop plain individual
notes — they are handled in Step 4). For each kept discussion map to the
neutral shape:
- `id` ← discussion `id` (a string hash).
- `path` ← the first note's `position.new_path` (fall back to `old_path`).
- `line` ← `position.new_line` (fall back to `old_line`); `startLine` from
  `position.line_range.start.new_line` when present, else null.
- `replyToDatabaseId` ← the first note's `id`.
- `isOutdated` ← `true` when the diff `position` is null/absent, else `false`
  (a heuristic — GitLab has no direct "outdated" flag, so a discussion whose
  position the API no longer resolves is treated as outdated).
- `viewerCanResolve` ← `true` (a resolvable discussion can be resolved by a
  member; the server still re-checks before resolving).
- `comments` ← every note's `{author: note.author.username, createdAt:
  note.created_at, body: note.body}`.
- `diffHunk` ← omit (GitLab has no equivalent single hunk; the UI falls back to
  the path/line and your code reading).

For `reviewers`, list the MR's reviewers/approvers:
`GITLAB_HOST=$HOST glab api "projects/<ENC>/merge_requests/N/approvals"` (or the
MR's `reviewers[]`), as `[{login, state}]`.

## Step 4 — Fetch general PR comments / MR notes

**GitHub:**

```
gh api repos/OWNER/REPO/issues/N/comments --paginate \
  --jq '[.[] | {databaseId: .id, author: .user.login, type: .user.type, createdAt: .created_at, url: .html_url, body: .body}]'
```

`--paginate` may emit one JSON array PER PAGE — merge them. Exclude comments
authored by SELF and comments where `type` is `"Bot"`.

**GitLab** — fetch the top-level MR notes:

```
GITLAB_HOST=$HOST glab api "projects/<ENC>/merge_requests/N/notes?per_page=100" --paginate
```

Keep notes where `individual_note` is true (top-level, not part of a
discussion) and `system` is false; exclude notes authored by SELF and bot
authors (`author.bot` true). Map each to `{databaseId: note.id, author:
note.author.username, createdAt: note.created_at, url:
"https://$HOST/REPO/-/merge_requests/N#note_<note.id>", body: note.body}`.

(Either provider) mention how many comments you excluded. If there are 0
threads AND 0 general comments, tell the user there is nothing to reply to and
STOP — do not start a session.

## Step 5 — Propose a per-comment plan

First, pull this repo's priors from past sessions (read-only, no network):

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" suggest --repo $REPO --repo-dir $REPO_DIR
```

(add `--provider gitlab` for a GitLab MR). It prints JSON: `actionPriors`
(this repo's historical fix/reply/skip rates), `categoryPriors` (rates per
category), and `templates` (your reusable reply snippets). Use it to:
- Lean `suggestedAction`/`confidence` toward the repo's norm for similar
  comments (e.g. if this repo almost always fixes "error-handling" feedback,
  bias such a comment toward `fix` with higher confidence).
- When a comment matches a template's intent, pre-seed its draft from that
  template body (the UI fills `{{author}}`/`{{sha}}` placeholders).

Then, for each unresolved thread:
1. Read the file at `path` from roughly (startLine ?? line) − 30 to line + 30.
   If outdated or the file/line is gone, rely on the `diffHunk`. Grep for
   symbols if needed, but keep extra reading small.
2. Decide `suggestedAction` and `confidence`:
   - `"fix"` — a concrete, in-scope change you fully understand. Write a
     one-paragraph `fixPlan`. Confidence: `high` only when the change is
     unambiguous and local; `medium` when you are sure of intent but not exact
     shape; `low` if you would have to interpret.
   - `"reply"` — questions, opinions, out-of-scope, ambiguous, or already
     handled. `fixPlan` null. Never propose a speculative fix — suggest
     `"reply"` with a clarifying question instead.
3. For HIGH-confidence small fixes only, optionally write `proposedDiff`: a
   short unified diff (≤ 40 lines) sketching the change. It is a prediction,
   not an applied patch — the UI labels it a sketch (not yet applied). Omit it
   when unsure; never exceed 80 lines.

Do the same for each general comment (these can also be `"fix"`).

Optionally tag each thread/comment with a short `category` string (e.g.
`"tests"`, `"error-handling"`, `"naming"`, `"docs"`). It is purely for the
learning loop — the server records it into history so future `suggest` runs can
bias priors by category. It is never shown to the reviewer.

## Step 6 — Start the session

```
SESSION=/tmp/pr-replies/<owner>-<repo>-pr<N>-<unix-epoch>
mkdir -p $SESSION
```

Write `$SESSION/triage.payload.json` following EXACTLY the schema of
`${CLAUDE_PLUGIN_ROOT}/examples/payload.triage.json` (`version: 2`, repo, pr
with `reviewers`, generatedAt, reviewThreads with viewerCanResolve /
suggestedAction / confidence / fixPlan / proposedDiff, issueComments likewise).

For **GitLab**, follow `${CLAUDE_PLUGIN_ROOT}/examples/payload.triage.gitlab.json`
instead: set `provider: "gitlab"`, `repo.host: "$HOST"`, `repo.nameWithOwner` to
the `group/project` path, and `pr.number` to the MR IID. (For GitHub leave
`provider` absent — it defaults to GitHub.)

Optionally include `pr.assignableUsers` (an array of collaborator logins) to
populate the browser's "assign to a teammate" picker. Reviewer grouping and the
per-comment assignee/@-mention are entirely browser-side — they need nothing
else from you, and you never act on them.

Launch the server as a long-lived **background** process that must outlive this
step — it hosts the whole session (Claude Code: pass `run_in_background`; Codex
or any other runner: start it detached, e.g. `nohup … &`). Do NOT block on it:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" serve --session $SESSION --repo-dir $REPO_DIR
```

For **GitLab**, add `--provider gitlab` (and `--host $HOST` for a self-managed
instance) to the `serve` command. Add `--no-post` when `--dry-run`. For
reply-only mode (`--no-fix` or
cross-repo): skip the triage payload, write the reply payload (Step 9) now,
and launch with `--start-phase reply`, then jump to Step 10.

The browser opens automatically; the URL is also printed on the server's
stderr.

## Step 7 — Wait for triage

Run this in the **foreground** to block while the user works in the browser. It
self-limits to ~9 minutes (`--timeout-secs 540`); allow it up to ~10 minutes
(600000 ms) wherever your runner lets you set a per-command timeout, and simply
re-run it after a timeout — the server and the browser tab survive untouched:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" wait --session $SESSION --phase triage --timeout-secs 540
```

If `wait` exits with code **1** it printed no result block (bad session). This
means `serve` never wrote `session.json` — almost always a boot/validation
error. Re-read the `serve` stderr, fix the payload or environment, relaunch
`serve`, and only then re-run `wait`. Do not try to parse a result on exit 1.

Otherwise parse the JSON between `===PR_REPLIES_RESULT===` and
`===END_PR_REPLIES_RESULT===` (exit 0/2/3):
- `status: "wait_timeout"` → the user is still working; just re-run the same
  `wait` command (the tab is untouched). After 3 consecutive timeouts, ask the
  user whether to keep waiting.
- `status: "server_exited"` → relaunch in the background with
  `serve --session $SESSION --resume` (state is restored from disk, the
  browser reopens), then re-run `wait`.
- `status: "cancelled"` → confirm nothing was changed or posted, run
  `server.js stop --session $SESSION --cleanup`, and stop entirely.
- `status: "submitted"` → `decisions[]` holds
  `{kind, threadId|databaseId, action, guidance}` per item. Items with
  `action: "skip"` are dropped from everything below.

## Step 8 — Implement the fixes (live progress)

For each decision with `action: "fix"` (its `guidance` overrides your fixPlan),
in order:

1. `node .../server.js emit --session $SESSION --type fix_start --item <key>`
   where `<key>` is `review:<threadId>` or `issue:<databaseId>`.
2. Make the change with Edit/Write.
3. If the repo has an obvious check (package.json scripts, Makefile…), run it,
   reporting via
   `emit --type check --name <script> --status running|pass|fail [--detail "…"]`.
   If your change broke it, fix it or report and ask rather than pushing broken
   code.
4. Commit ONE commit per logical fix:
   `git add <files> && git commit -m "address review: <summary> (re: <path>:<line>)"`,
   record the short SHA, then
   `emit --type fix_done --item <key> --sha <shortsha> --summary "<one line>"`.
   If you could not fix it: `emit --type fix_fail --item <key> --reason "…"` and
   treat the item as reply-only.

**After EVERY emit, check its stdout**: it prints `{"ok":…,"abort":…}`. If
`"abort": true`, the user asked to stop — emit nothing further except
`emit --type note --text "Aborted — remaining fixes converted to replies."`,
treat all remaining fix items as reply-only, and go to Step 9.

If an emit command exits non-zero saying the server is unreachable, keep
working (events are saved to the session dir) and run `serve --resume` in the
background before Step 9.

After all fixes: `git push`, then `emit --type push --status ok` (or
`--status fail --detail "<first error line>"` and ask the user before retrying).

## Step 9 — Draft replies and advance

`emit --type drafting` first. For every non-skipped item write **two** reply
variants — the user picks one in the browser:
- `draft` (**Direct / fix-plan**): concise and technical. Fixed items read like
  "I'll apply the fix by <what changed> — in `<shortsha>`." or "Fixed in
  `<shortsha>` — <one line>." Reply-only items give a precise technical answer.
- `draftHumanized` (**Humanized**): the SAME factual substance in a warmer,
  more conversational tone. Both variants must agree on every claim and on the
  `fixedIn` SHA — never invent claims about the code.

Shared rules for both variants:
- Set `fixedIn` to the short SHA and `resolveDefault` to true when the thread's
  `viewerCanResolve` is true.
- Keep each under ~120 words, no greetings/sign-offs. If the requested change
  already exists, say where. If you cannot determine the answer from the code,
  ask a clarifying question instead of guessing.
- General comments post as NEW top-level PR comments, so quote the first 1–2
  lines as a markdown `> quote` and @-mention the author (in both variants).
- Do NOT append any signature — the server appends the user's configured
  signature automatically.

Write `$SESSION/reply.payload.json` following EXACTLY
`${CLAUDE_PLUGIN_ROOT}/examples/payload.reply.json` (`version: 2`; threads
carry draft / draftHumanized / fixedIn / resolveDefault / viewerCanResolve).
For **GitLab**, use
`${CLAUDE_PLUGIN_ROOT}/examples/payload.reply.gitlab.json` and keep the same
`provider` / `repo.host` you wrote in Step 6. Do NOT include fix diffs — the
server reads them from git itself. Then:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" advance --session $SESSION --phase reply
```

If it exits 1 with validation errors, fix the payload JSON and re-run. If it
exits 3 (server gone), run `serve --resume` in the background first.

## Step 10 — Wait for replies

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" wait --session $SESSION --phase reply --timeout-secs 540
```

(Foreground, same ~10-minute ceiling and the same `wait_timeout` /
`server_exited` handling as Step 7.) The server posts, retries rate limits, and
resolves threads itself; the user handles partial failures in the browser
(Retry failed / Finish anyway), so the sentinel result is final:
- `status: "submitted"` → `posted[]` (with URLs), `errors[]`, `skipped[]`,
  `resolved[]`, `resolveErrors[]`.
- `status: "cancelled"` → no replies were posted; if fixes were pushed in
  Step 8, note that those commits remain on the branch.
- `status: "timeout"` → the session window elapsed; offer to relaunch with
  `serve --resume`.

## Step 11 — Report & clean up

The server records an audit entry for every finished session (submitted,
cancelled, or timed out) to `~/.config/pr-replies/history/` automatically — you
do not write it. Users browse past sessions and manage reply templates from the
**hub** — they open it with the **`/pr-dashboard`** command (which runs
`server.js serve --home`). Mention `/pr-dashboard` if the user asks where their
history/templates live.

Summarize as a short table: fixes pushed (SHAs), replies posted (URLs),
threads resolved, skipped, failed (including `resolveErrors`, which are
non-fatal). Then:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" stop --session $SESSION
```

On a clean finish also `rm -rf $SESSION`. If anything failed, KEEP the session
dir, tell the user its path, and offer a retry (`serve --resume` restores the
reply phase with per-item state intact).
