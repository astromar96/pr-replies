---
description: Triage, fix, and reply to GitHub PR comments in a browser UI
argument-hint: "[pr-number-or-url] [--no-fix]"
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(rm:*), Bash(date:*), Read, Grep, Glob, Edit, Write
---

# Reply to PR comments via browser UI

You will fetch this PR's unresolved feedback, let the user triage it in a
browser UI, implement the fixes they approve, then let them review and send
replies from a second browser UI. Follow these steps exactly.

**Never post any comment to GitHub yourself with `gh`** — all posting happens
through the review server in Step 9. The two `node` server commands BLOCK
until the user finishes in the browser; that is expected.

Arguments: "$ARGUMENTS"
If the arguments contain `--no-fix`, skip Steps 6–7 (triage UI and fixes) and
treat every item as reply-only.

## Step 1 — Preflight

Run `gh auth status`. If it fails, tell the user to run `gh auth login` and stop.

## Step 2 — Resolve the PR

First remove `--no-fix` from the arguments; what remains (possibly nothing) is
the PR argument.

- If it is a URL like `https://github.com/OWNER/REPO/pull/N`, parse OWNER, REPO, N.
  If that repo is NOT the repo of the current directory, you cannot fix code
  locally: tell the user and continue in reply-only mode (as if `--no-fix`),
  relying on each thread's `diffHunk` for context instead of reading files.
- If it is a bare number, use it with the current repo (`gh repo view --json nameWithOwner`).
- If empty, run `gh pr view --json number,title,url,headRefName,author` to
  autodetect from the current branch. If that fails, ask the user for a PR
  number or URL and stop.

Also fetch the current user's login: `gh api user --jq .login` (call it SELF).

Unless `--no-fix`: confirm the working tree is on the PR's head branch
(`git branch --show-current` vs `headRefName`; if different, run
`gh pr checkout N`). Then run `git status --porcelain` — if there are
uncommitted changes, tell the user fixes need a clean tree and stop.

## Step 3 — Fetch unresolved review threads

Run this query via `gh api graphql -f query='...' -F owner=OWNER -F name=REPO -F number=N`,
repeating with `-F cursor=<endCursor>` while `hasNextPage` is true (warn the
user and stop collecting past 200 threads):

```graphql
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title url author { login } headRefName
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path startLine line
          comments(first: 50) {
            nodes { databaseId body author { login } createdAt diffHunk }
          }
        }
      }
    }
  }
}
```

Keep ONLY nodes where `isResolved` is false. For each kept thread record:
thread `id`, `isOutdated`, `path`, `startLine`, `line`, the FIRST comment's
`databaseId` (as `replyToDatabaseId`), the first comment's `diffHunk`, and
every comment's author/createdAt/body. Flatten each comment's `author` object
to just its `login` string — the payload schema expects `"author": "name"`.

## Step 4 — Fetch general PR comments

```
gh api repos/OWNER/REPO/issues/N/comments --paginate \
  --jq '[.[] | {databaseId: .id, author: .user.login, type: .user.type, createdAt: .created_at, url: .html_url, body: .body}]'
```

Note: with `--paginate`, the output may contain one JSON array PER PAGE —
merge them into a single list.

Exclude comments authored by SELF and comments where `type` is `"Bot"`
(mention in one line how many bot/self comments you excluded).

If there are 0 unresolved threads AND 0 general comments after filtering,
tell the user there is nothing to reply to and STOP — do not launch the server.

## Step 5 — Propose a per-comment plan

For each unresolved thread:
1. Read the file at `path` from roughly (startLine ?? line) − 30 to line + 30.
   If the thread is outdated or the file/line no longer exists, rely on the
   `diffHunk`. If the comment names a symbol defined elsewhere, you may Grep
   for it, but keep extra reading small.
2. Decide `suggestedAction`:
   - `"fix"` — the comment requests a concrete, in-scope code change you fully
     understand. Also write a one-paragraph `fixPlan` describing exactly what
     you would change.
   - `"reply"` — questions, opinions, out-of-scope requests, anything
     ambiguous, or anything already handled by the current code. `fixPlan` is null.
   Never propose a speculative fix for a comment you don't fully understand —
   suggest `"reply"` and plan a clarifying question instead.

Do the same for each general comment (these can also be `"fix"`, e.g. "update
the changelog").

## Step 6 — Triage UI (skip if --no-fix)

Write the payload to `/tmp/pr-replies-N-triage-<unix-epoch>.json` following
EXACTLY the schema of `${CLAUDE_PLUGIN_ROOT}/examples/payload.triage.json`
(`version: 1`, `mode: "triage"`, repo, pr, generatedAt, reviewThreads with
suggestedAction/fixPlan, issueComments with suggestedAction/fixPlan).

Then run — with a 600000 ms Bash timeout; this BLOCKS until the user finishes:

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" --payload /tmp/pr-replies-N-triage-<epoch>.json --timeout-secs 540
```

(If the user has raised their Bash timeout and asks for a longer window, set
`--timeout-secs` to the Bash timeout in seconds minus 60.)

The browser opens automatically; if it doesn't, the URL is printed at the top
of the command's live output (stderr). After the command exits you can also
relay it when relaunching.

Parse the JSON between `===PR_REPLIES_RESULT===` and `===END_PR_REPLIES_RESULT===`:
- `status: "cancelled"` → confirm nothing was changed or posted, and stop entirely.
- `status: "timeout"` → tell the user the window elapsed; offer to relaunch
  (the payload file is still in /tmp).
- `status: "submitted"` → `decisions[]` holds `{kind, threadId|databaseId, action, guidance}`
  per item. Items with `action: "skip"` are dropped from everything below.

## Step 7 — Implement the fixes (skip if --no-fix or no "fix" decisions)

For each decision with `action: "fix"` (honoring its `guidance` text, which
overrides your fixPlan):
1. Make the change with Edit/Write.
2. If the repo has an obvious check (package.json scripts, Makefile, etc.),
   run the relevant test/lint. If it fails because of your change, fix it or —
   if you can't — report and ask the user rather than pushing broken code.
3. Commit ONE commit per logical fix:
   `git add <files> && git commit -m "address review: <summary> (re: <path>:<line>)"`.
   Record the short SHA for that thread.

After all fixes: `git push`. If push fails, report the error and ask before retrying.

## Step 8 — Draft replies

Draft a reply for every non-skipped item:
- Fixed items: state what changed and reference the commit, e.g.
  "Fixed in `abc1234` — <one line on what changed>."
- Reply-only items: a concise answer. Under ~120 words, friendly, technical,
  no greetings or sign-offs. Address the reviewer's specific point. If the
  requested change already exists, say so and where. If you cannot determine
  the right answer from the code, ask a clarifying question instead of
  guessing. Never invent claims about the code. Markdown is fine.
- General comments post as NEW top-level PR comments (no threading), so quote
  the first 1–2 lines of the original as a markdown `> quote` and @-mention
  the author.

## Step 9 — Reply UI

Write the payload to `/tmp/pr-replies-N-reply-<unix-epoch>.json` following
EXACTLY the schema of `${CLAUDE_PLUGIN_ROOT}/examples/payload.reply.json`
(`mode: "reply"`, each item carries `draft` and, when fixed, `fixedIn` short SHA).

Then run (600000 ms Bash timeout, BLOCKS):

```
node "${CLAUDE_PLUGIN_ROOT}/server/server.js" --payload /tmp/pr-replies-N-reply-<epoch>.json --timeout-secs 540
```

The server posts the approved replies to GitHub itself on submit.

## Step 10 — Report

Parse the sentinel JSON:
- `status: "submitted"` → summarize as a short table: fixes pushed (SHAs),
  replies posted (with URLs), skipped, failed.
- `status: "timeout"` → the window elapsed; offer to relaunch with the same
  payload file.
- `status: "cancelled"` → confirm no replies were posted. If fixes were pushed
  in Step 7, note that those commits remain on the branch.
- If `errors[]` is non-empty: each entry carries the attempted `body`. Offer a
  targeted retry: write a NEW reply payload containing only the failed items
  with `draft` set to that body, and relaunch Step 9.
- If the command itself was interrupted with no sentinel block, nothing was
  posted; offer to relaunch.

Finally clean up: `rm /tmp/pr-replies-N-*.json`.
