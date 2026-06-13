---
description: Triage, fix, and reply to GitHub PR comments in a live browser session
argument-hint: "[pr-number-or-url] [--no-fix] [--allow-cross-repo] [--dry-run]"
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(rm:*), Bash(date:*), Bash(mkdir:*), Bash(ls:*), Read, Grep, Glob, Edit, Write
---

# Reply to PR comments via a live browser session

You will fetch this PR's unresolved feedback, then run ONE browser session that
spans the whole flow: the user triages in the browser → you implement the
approved fixes while the browser shows live progress → the user reviews and
sends the replies from the same tab. Follow these steps exactly.

**Never post any comment to GitHub yourself with `gh`** — all posting happens
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
  posted to GitHub.

## Step 1 — Preflight

Run `gh auth status`. If it fails, tell the user to run `gh auth login` and stop.

## Step 2 — Resolve the PR

Remove the known flags from the arguments; what remains (possibly nothing) is
the PR argument.

- URL `https://github.com/OWNER/REPO/pull/N` → parse OWNER, REPO, N. If that
  repo is not the current directory's repo: with `--allow-cross-repo`, check
  `gh pr view N --repo OWNER/REPO --json headRepositoryOwner,headRepository,headRefName`
  — if the local checkout's `origin` IS the PR's head fork and you are on
  `headRefName`, fixes are allowed; otherwise continue in reply-only mode
  (as if `--no-fix`), relying on each thread's `diffHunk` for context.
- Bare number → current repo (`gh repo view --json nameWithOwner`).
- Empty → autodetect with `gh pr view --json number,title,url,headRefName,author`;
  if that fails, ask the user for a PR number or URL and stop.

Fetch the current user's login: `gh api user --jq .login` (call it SELF).

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

## Step 3 — Fetch unresolved review threads

Run via `gh api graphql -f query='...' -F owner=OWNER -F name=REPO -F number=N`,
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
          comments(first: 50) {
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

From `reviews`, compute `reviewers`: the latest non-`COMMENTED` review state
per login, as `[{login, state}]` (states like APPROVED / CHANGES_REQUESTED).

## Step 4 — Fetch general PR comments

```
gh api repos/OWNER/REPO/issues/N/comments --paginate \
  --jq '[.[] | {databaseId: .id, author: .user.login, type: .user.type, createdAt: .created_at, url: .html_url, body: .body}]'
```

`--paginate` may emit one JSON array PER PAGE — merge them. Exclude comments
authored by SELF and comments where `type` is `"Bot"` (mention how many you
excluded). If there are 0 threads AND 0 general comments, tell the user there
is nothing to reply to and STOP — do not start a session.

## Step 5 — Propose a per-comment plan

For each unresolved thread:
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
   not an applied patch — the UI labels it "Claude's sketch". Omit it when
   unsure; never exceed 80 lines.

Do the same for each general comment (these can also be `"fix"`).

## Step 6 — Start the session

```
SESSION=/tmp/pr-replies/<owner>-<repo>-pr<N>-<unix-epoch>
mkdir -p $SESSION
```

Write `$SESSION/triage.payload.json` following EXACTLY the schema of
`${CLAUDE_PLUGIN_ROOT}/examples/payload.triage.json` (`version: 2`, repo, pr
with `reviewers`, generatedAt, reviewThreads with viewerCanResolve /
suggestedAction / confidence / fixPlan / proposedDiff, issueComments likewise).

Launch the server **in the background** (run_in_background, NOT a foreground
call — it lives for the whole session):

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" serve --session $SESSION --repo-dir $REPO_DIR
```

Add `--no-post` when `--dry-run`. For reply-only mode (`--no-fix` or
cross-repo): skip the triage payload, write the reply payload (Step 9) now,
and launch with `--start-phase reply`, then jump to Step 10.

The browser opens automatically; the URL is also printed on the server's
stderr.

## Step 7 — Wait for triage

Run in the FOREGROUND with a 600000 ms Bash timeout (this blocks while the
user works in the browser):

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

`emit --type drafting` first. Draft a reply for every non-skipped item:
- Fixed items: "Fixed in `<shortsha>` — <one line on what changed>." Set
  `fixedIn` to the short SHA and `resolveDefault` to true when the thread's
  `viewerCanResolve` is true.
- Reply-only items: a concise answer, under ~120 words, friendly, technical,
  no greetings/sign-offs. If the requested change already exists, say where.
  If you cannot determine the answer from the code, ask a clarifying question
  instead of guessing. Never invent claims about the code.
- General comments post as NEW top-level PR comments, so quote the first 1–2
  lines as a markdown `> quote` and @-mention the author.
- Do NOT append any signature — the server appends the user's configured
  signature automatically.

Write `$SESSION/reply.payload.json` following EXACTLY
`${CLAUDE_PLUGIN_ROOT}/examples/payload.reply.json` (`version: 2`; threads
carry draft / fixedIn / resolveDefault / viewerCanResolve). Do NOT include fix
diffs — the server reads them from git itself. Then:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" advance --session $SESSION --phase reply
```

If it exits 1 with validation errors, fix the payload JSON and re-run. If it
exits 3 (server gone), run `serve --resume` in the background first.

## Step 10 — Wait for replies

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" wait --session $SESSION --phase reply --timeout-secs 540
```

(600000 ms Bash timeout; same `wait_timeout` / `server_exited` handling as
Step 7.) The server posts, retries rate limits, and resolves threads itself;
the user handles partial failures in the browser (Retry failed / Finish
anyway), so the sentinel result is final:
- `status: "submitted"` → `posted[]` (with URLs), `errors[]`, `skipped[]`,
  `resolved[]`, `resolveErrors[]`.
- `status: "cancelled"` → no replies were posted; if fixes were pushed in
  Step 8, note that those commits remain on the branch.
- `status: "timeout"` → the session window elapsed; offer to relaunch with
  `serve --resume`.

## Step 11 — Report & clean up

Summarize as a short table: fixes pushed (SHAs), replies posted (URLs),
threads resolved, skipped, failed (including `resolveErrors`, which are
non-fatal). Then:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" stop --session $SESSION
```

On a clean finish also `rm -rf $SESSION`. If anything failed, KEEP the session
dir, tell the user its path, and offer a retry (`serve --resume` restores the
reply phase with per-item state intact).
