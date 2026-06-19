---
name: pr-dashboard
description: Open the pr-replies hub — session history and reply templates — in your browser
argument-hint: ""
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Read
---

<!-- GENERATED FILE — edit src/agent/pr-dashboard.workflow.md and run
`npm run build:agents`. Do not edit the generated commands/SKILL files directly. -->

# Open the pr-replies hub

The **hub** is a payload-less browser view that spans every session: live
sessions on this machine, the audit **history** of finished sessions, and the
reply **templates** editor. It reads only from `~/.config/pr-replies/` and never
touches a live session's state. One hub runs per machine.

## Step 1 — If a hub is already running, just surface it

Read `~/.config/pr-replies/home.json` (use `$PR_REPLIES_CONFIG_DIR/home.json`
when that env var is set). If it exists and its `pid` is alive
(`kill -0 <pid>` succeeds), the hub is already up — print its `url` and stop.
Do not launch a second one.

## Step 2 — Launch the hub

Launch as a long-lived **background** process that outlives this turn (Claude
Code: pass `run_in_background`; Codex or any other runner: start it detached,
e.g. `nohup … &`). Pass `--repo-dir "$PWD"` so the Templates view merges this
repo's local templates (`.pr-replies/templates.json`) on top of the user's:

```
node "{{ROOT}}/server/server.js" serve --home --repo-dir "$PWD"
```

The hub picks a random loopback port, writes `home.json`, opens the browser
automatically, and prints its URL on stderr — surface that URL to the user.
It lands on **History**; switch to **Templates** with the in-app nav (or `g t`).

To stop the hub later, the user closes the tab and the process with Ctrl-C in
its terminal, or it exits on the next machine restart.
