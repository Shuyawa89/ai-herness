---
name: task-dashboard
description: Show progress from existing agent sessions in a local dashboard, with independent tasks, plans, participants, workspaces, and history. Use when the user wants visible progress without a special agent launcher or harness extension.
---

# Task dashboard

Existing Pi, Claude Code, Codex, and other sessions continue their ordinary work. The shared viewer displays explicitly reported tasks; it does not discover processes, supervise agents, or infer failure from old reports. A small Go binary handles registration, safe file updates, Git observations, and a loopback-only server. No extension, special agent launch option, package dependency, OS service registration, or login autostart is required.

## Setup in the current session

The canonical skill directory is the installed skill's actual directory after resolving symlinks. The default shared state is `~/.local/state/task-dashboard`; `--root <absolute-directory>` isolates another instance. Serve only dashboard data, never the source project. The agent handles setup and shares the URL; the user does not need to learn these commands.

Build once during setup (Go is needed to build, not to run). The build script uses an available Go toolchain or `mise` with Go 1.27.2 and prints the binary path:

```sh
bash /absolute/skill/scripts/build.sh /absolute/state/bin/task-dashboard
/absolute/state/bin/task-dashboard --root /absolute/state server start
/absolute/state/bin/task-dashboard --root /absolute/state register --title 'Actual task title' --cwd /absolute/project
```

Replace paths and title with actual values and shell-quote arguments. Registration returns the generated task ID and `progress.json` path; retain both for the session and its children. `register --file /absolute/existing/progress.json --title 'Actual task title' --cwd /absolute/project` imports an existing report as a new independent task. A session registers once, not on every update. Rebuild after source/viewer changes; an already running server retains its executable until explicitly stopped and started.

`server start` reuses the authenticated server for that state folder or starts one detached from the calling session. `server status` and `server stop` inspect/stop only the verified owned server. The default port is `19437`. A port collision reports an error rather than taking over another process; start accepts `--port <available-port>`. Updates and registration still work while serving is stopped and do not start it. The agent starts the server during initial dashboard setup; after an explicit stop, leave it stopped until the user asks to reopen it. Progress files survive stop/restart. Stopping the shared server affects every task's browser display. The process is not registered to start after a reboot; abrupt OS/container cleanup can still end it.

## Short reports

The Go updater is the writer for the new shared workflow. It locks each report and atomically merges changes, preserving concurrent participants. Whole-file replacements during child reports would lose updates. A report contains only a stable ID, state, and short activity; repeated full-file reads, periodic prose, and per-tool reports are unnecessary.

```sh
/absolute/bin/task-dashboard update /absolute/progress.json agent main --name 'Coordinator' --status running --launch-method session --cwd /absolute/project --current 'Planning implementation'
/absolute/bin/task-dashboard update /absolute/progress.json agent backend --name 'Backend' --parent-id main --launch-method subagent --status running --cwd /absolute/child-worktree --current 'Implementing API'
/absolute/bin/task-dashboard update /absolute/progress.json agent backend --status running --current 'Checking validation' --event 'API ready for tests'
/absolute/bin/task-dashboard update /absolute/progress.json agent backend --status completed --current 'API checks passed'
/absolute/bin/task-dashboard update /absolute/progress.json task --patch '{"phase":1,"phases":[{"name":"Design","items":[{"name":"Specify behavior","status":"completed"}]},{"name":"Build","items":[{"name":"Implement API","status":"running"}]}]}'
```

The task patch preserves participants and events. Pass `--cwd` when the known working directory changes or Git metadata needs refreshing. Omission preserves the participant's existing observation; never substitute the parent directory for an unknown child directory. Git branch, repository root, primary/linked-worktree kind and observation timestamp are obtained by the binary without model inference. Model names stay absent when unknown.

## Delegation boundaries

The coordinator registers each child **before** dispatch, because a synchronous subagent call may block the parent until children finish. Write-capable children receive this short handoff with actual paths and IDs:

> Dashboard: binary `<absolute binary>`, report `<absolute progress.json>`, your ID `<id>`. At meaningful boundaries, run `<binary> update <report> agent <id> --status running --current '<short activity>'`; optionally add `--event '<milestone>'`. Report completed/failed/waiting with the result or blocker. Before delegating, register the new child with a unique ID/name, your own ID as its --parent-id, known --cwd, launch method and running state; pass this handoff along. Do not overwrite the full JSON.

The coordinator finalizes children on result return, including failures. Read-only children have parent-reported dispatch/result boundaries and no intermediate-update guarantee. Already running sessions do not inherit a new handoff automatically. The helper records real reporting start/end times, preserving known times; repeated terminal reports freeze the end, and an explicit new running interval after terminal work restarts timing. Historical missing starts are not invented. Completion reflects acceptance requirements, not merely a finished tool or turn.

## Viewer and compatibility

The browser selects independent tasks in the sidebar; the chosen task retains its plan, agents, models, elapsed times, and filtered histories. Work items can be nested and phase counts are not fixed. A running indicator shows reported execution state, not a heartbeat or proof of liveness. Errors loading a file preserve the last valid report for that task and are distinct from reported task failures.

Read [the JSON contract](references/progress-data.md) when changing phases, importing a report, or writing additional fields. Keep credentials, private prompts, thinking and raw tool output out of all reports. Example data is fictional and must be replaced before presenting an actual task.

Standalone static dashboards remain supported: copy the HTML/CSS/JavaScript assets (not Go source) into a dedicated output folder, initialize an ordinary `progress.json`, and serve only that folder on loopback using an available static server. HTML defaults to standalone mode; the shared Go server explicitly selects multi-task mode. The Go `update` command also accepts standalone report paths. The older `scripts/update_progress.py` remains compatible for existing macOS/Linux workflows; do not mix update implementations on one report unless their shared lock protocol is preserved. Existing copied viewers need refreshed assets for new display features.
