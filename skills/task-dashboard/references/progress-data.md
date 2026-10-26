# Progress JSON contract

`../assets/progress.example.json` demonstrates the format with visibly labeled fictional content. Text shown to the user follows the conversation language. The contract is:

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


## Workspace observations

An optional `workspace` object on the task or an agent contains required `cwd` and `checkoutKind`, with optional `repoRoot`, `branch`, `commit`, and `observedAt`. `checkoutKind` is `primary`, `worktree`, `not-git`, or `unavailable`. The Go tool obtains these from an explicitly supplied working directory. Branch name and checkout kind are independent; detached HEAD has no branch and may have a short commit. Missing or inaccessible information is not inferred from the coordinator. An observation reflects the last report, not continuous process inspection. `cwd` is a working directory, not the file currently being edited.

The shared index stores task IDs and relative report paths. Identical task titles have independent IDs, participants, phases, and histories. Index registration and reports use file locks and atomic replacement. Only the selected task is fetched each second; the compact task list refreshes less often. An unavailable report does not imply failed work.

## Response boundaries and list filtering

`finish` closes the current response by atomically reporting the coordinator and task state. Normal result delivery is completed, a question or approval request is waiting, and an unrecoverable error is failed. Product acceptance and plan-item completion remain separate facts. Remaining running/waiting/failed participants keep their reported states and can keep the task active or needing attention. Unknown historical starts are not backfilled.

The task list uses one classification for its badge and filters: unavailable reports and attention states need attention; ordinary running and completed reports have their own categories. Pending/unknown entries remain visible under all tasks. Filtering never changes the selected task or its underlying report.
