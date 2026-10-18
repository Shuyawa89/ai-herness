---
name: task-dashboard
description: Show one long-running task in a local dashboard using a reusable static template and an ordinary progress.json file. Use from an existing Pi, Claude Code, Codex, or other agent session when the user wants visible plans, participants, progress, and history.
---

# Task dashboard

The current agent continues its existing task and session. A reusable viewer displays agent-reported progress from one ordinary `progress.json`; no agent wrapper, CLI extension, special launch option, token, or runtime integration is required. The agent handles setup and supplies the browser URL. The user does not need to learn a dedicated command.

## Reusable viewer

The skill's canonical directory, after resolving installed symlinks, contains `assets/`. Copy its static HTML, CSS, and JavaScript files into a dedicated folder such as `.temp-local/task-dashboard/` in the working project. Existing user files remain untouched. `progress.example.json` is labeled example data, not a report about current work; the delivered `progress.json` describes the actual task, participants, and history.

Only that dedicated folder is served on loopback with an ordinary static server already available in the environment. For example, Python's built-in server accepts `python3 -m http.server 8765 --bind 127.0.0.1 --directory <actual-dashboard-directory>`. Choose an available port and keep the server available using the environment's normal background-process facilities. An equivalent static server is fine; no framework or package installation is required. The agent opens or shares the resulting URL and verifies that a real file update reaches the existing page.

The viewer polls relative `progress.json` about once per second without model activity. A stopped static server makes the page unavailable; a stopped reporting agent leaves the last report visible. This is a progress display, not process supervision or exact liveness detection. Old reports never imply that an agent stopped. A file-loading error is separate from a reported task failure.

## Progress data

`assets/progress.example.json` demonstrates the format with visibly labeled fictional content. Text shown to the user follows the conversation language. The contract is:

| Field | Meaning |
| --- | --- |
| `title` | Required task title. |
| `summary`, `id` | Optional short task description and identifier. |
| `status` | Reported `pending`, `running`, `waiting`, `failed`, or `completed`; omitted/`unknown` displays as unreported. |
| `startedAt`, `endedAt` | Optional known timestamps as ISO strings or Unix epoch milliseconds. |
| `phase` | Zero-based index into `phases`. |
| `phases` | Arbitrary array of `{name, items}`; no fixed phase names or count. |
| `items` | Work items with `name`, optional `status`, and optional recursive `children`. |
| `agents` | Participants with unique `id`, `name`, and optional `role`, `status`, `current`, `reason`, `model`, `startedAt`, `endedAt`, `parentId`, `launchMethod`. |
| `events` | History entries with `title` and optional `agentId`, `at`, `detail`, `kind`. A missing or null `agentId` is task-wide history. |

Participant `launchMethod`, when useful, is `session`, `subagent`, or `command`. A command-launched agent belongs in the same list as a subagent. `parentId` represents a known relationship rather than an assumed hierarchy. Event `kind` is `progress`, `milestone`, `warning`, `error`, or `tool`. Unknown status remains absent or explicitly `unknown`. A completed/failed item without a known end time shows an unknown elapsed time. Models and timestamps stay absent or null when unknown; estimates are never presented as observations. Only task-specific summaries belong in the file, without credentials, private prompts, thinking, or raw tool output.

## Low-effort reporting

Updates happen at meaningful boundaries: starting or finishing work, phase or plan changes, participant changes, blockers, and completion. The viewer's polling and elapsed clock require no model calls. Reporting needs only a stable ID, state, and short activity; repeated full-file reads, periodic prose, and per-tool reports are unnecessary.

The canonical skill directory contains `scripts/update_progress.py`, a small Python standard-library file updater for macOS/Linux. It merges changes under a shared file lock and atomically replaces the JSON, preserving other participants. It is not an agent launcher or extension. After initializing the actual task's JSON, all concurrent writers, including the coordinator, use this helper. Direct whole-file replacements while children report would lose their updates.

The agent substitutes actual absolute paths in these examples; the user need not run them:

```sh
python3 /absolute/skill/scripts/update_progress.py /absolute/dashboard/progress.json task --patch '{"status":"running"}'
python3 /absolute/skill/scripts/update_progress.py /absolute/dashboard/progress.json agent main --name 'Coordinator' --status running --launch-method session --current 'Planning implementation'
python3 /absolute/skill/scripts/update_progress.py /absolute/dashboard/progress.json agent backend --name 'Backend' --parent-id main --launch-method subagent --status running --current 'Implementing API'
python3 /absolute/skill/scripts/update_progress.py /absolute/dashboard/progress.json agent backend --status running --current 'Checking validation' --event 'API implementation ready for tests'
python3 /absolute/skill/scripts/update_progress.py /absolute/dashboard/progress.json agent backend --status completed --current 'API checks passed'
```

The coordinator registers each child **before** the dispatch tool call, since that call may block until all children finish. Every child prompt contains the same short reporting handoff with actual paths and stable IDs:

> Dashboard: file `<absolute progress.json>`, helper `<absolute update_progress.py>`, your ID `<id>`, parent `<parent-id>`. Report meaningful activity with `python3 <helper> <file> agent <id> --status running --current '<short activity>'`; add `--event '<milestone>'` when useful. Report `completed`, `failed`, or `waiting` with the result or blocker. Before delegating, register each child with its unique ID/name, your own ID as its `--parent-id`, launch method and running state, then pass this same handoff to it. Do not overwrite the full JSON.

All paths and arguments are shell-quoted for the actual environment. Names, roles, models, and launch methods are recorded when known. The coordinator finalizes each child immediately when its result returns, including failures; a read-only child receives no write requirement and has only parent-reported start/end, without intermediate updates. Nested delegation follows the same rule. Existing sessions need this handoff explicitly; they do not inherit it by discovery.

The helper records start time on the first `running` report and end time on a terminal report, preserving existing known times. A fresh `running` report after a terminal state starts a new interval. These are recorded work/delegation boundaries, not exact subprocess timing. Initialize new task/main timing before work and child timing before dispatch; never invent historical starts for old reports. A running indicator shows reported state, not a heartbeat or proof the process is alive. Reduced-motion users see a static indicator.

Task and plan changes use `task --patch '<JSON object>'` (for example `phase` and `phases` together), so concurrent participant updates survive. This patch cannot replace `agents` or `events`. Phase counts reflect completed phase tabs; the selected phase separately counts its leaf work items. Empty or unreported phase work never implies completion merely because the current phase advanced.

Reported state reflects known work: `waiting` includes its reason in the current activity or history; successful tools and a finished turn do not automatically complete the task. Completion follows the actual acceptance requirements. A final snapshot includes results and any limitations; the dashboard never substitutes for user acceptance or verification evidence.
