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

The coordinating agent is the sole writer of `progress.json`; other participants report to it rather than overwrite a shared snapshot. Updates happen at meaningful boundaries: starting or finishing work, phase or plan changes, participant changes, blockers, and completion. Periodic prose updates are unnecessary. The coordinating agent writes a complete JSON snapshot to a temporary file in the same folder and atomically replaces `progress.json`, avoiding partial writes. Read/parse failures preserve the last good display and recover on the next valid snapshot.

Reported state reflects known work: `waiting` includes its reason in the current activity or history; successful tools and a finished turn do not automatically complete the task. Completion follows the actual acceptance requirements. A final snapshot includes results and any limitations; the dashboard never substitutes for user acceptance or verification evidence.
