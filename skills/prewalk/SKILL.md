---
name: prewalk
description: Use a frontier model to inspect, make a concrete plan, and land one real code change before a cheaper worker model continues. Use for substantial features, refactors, or unfamiliar codebases where early direction is more valuable than paying frontier-model rates for all implementation.
---

# Prewalk

Prewalk preserves an expensive model's initial exploration trajectory instead of
handing a cheap model only a summary. The frontier pass plans the work and lands
one representative code change. The worker then continues from the same plan,
conversation, and first implementation pattern.

## When to use

- A feature, refactor, or unfamiliar area needs real exploration first.
- The remaining implementation is routine enough for a cheaper model.
- Do not use for a one-file trivial change or when every step needs frontier-level judgment.

## Contract

1. Inspect only the files needed to understand the task.
2. Use this session's recorded workspace, or allocate it once with Planning's
   `scripts/session-workspace.mjs` (run with `node`, the absolute project directory,
   and a short English task description). In Pi, call `prewalk_workspace` with
   that description. Write a concrete Japanese checklist to the returned
   workspace's `workflow-plan.md`.
3. Make exactly one non-plan code edit or write.
4. Handoff to the worker model.
5. The worker follows the checklist, verifies the result, and reports remaining risks.

The first change must be a real implementation choice, not formatting or a
placeholder. Keep the plan short, ordered, and verifiable. Plans use Japanese
headings, prose, and diagram labels; paths, commands, and identifiers stay intact.
Retain the workspace and exact plan path in handoffs and on session resume.
Existing plans are preserved; do not find an active plan by selecting the latest
folder or by falling back to the old shared `.temp-local/workflow-plan.md`.

## Pi: automatic handoff

Start Pi normally from the project being worked on:

```bash
pi
```

Arm the route before the task. The route comes from the machine-local config `~/.pi/agent/prewalk.json`; override it for one invocation with `/prewalk <second>` or `/prewalk <first> <second>`, and disarm with `/prewalk off`.

The Pi extension provides `prewalk_workspace` to reserve a directory named
`.temp-local/sessions/YYYYMMDD-HHMMSS-short-description/`, with numeric suffixes
on collisions. The model supplies a short English description of the actual
task. The tool reuses the same directory within a session, and the extension
records it in the session history for restart and compaction. Independent new
or forked sessions allocate their own directory.

The extension blocks source-code writes before a successful write to this
session's exact plan, rejects scratch writes outside its workspace, and blocks a
second code mutation. The frontier pass permits read-oriented built-ins,
`prewalk_workspace`, `edit`, and `write`. At the end of the first successful
source-code change turn, it switches models in the same Pi session and injects
a worker handoff message with the exact workspace and plan paths.

## Claude Code and Codex

Follow the same contract manually. Their normal CLI sessions do not expose Pi's
turn-level model-switch hook, so do not pretend that a fresh CLI session has the
same context. Keep the plan file and first change, then explicitly start or
select the intended worker model.

## Limits

- Prewalk is an execution handoff, not a replacement for human approval on risky work.
- Do not put API keys, provider configuration, or session logs in the harness repository.
- A model can make several read-only tool calls and write scratch files inside its session workspace before the first source-code change; “one action” means one source-code mutation outside `.temp-local/`.
