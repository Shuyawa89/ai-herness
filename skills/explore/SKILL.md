---
name: explore
description: Investigate a task before planning. Use for unfamiliar code, unclear requirements, or competing implementation options.
---

# Explore

Inspect only what is needed to establish facts. Do not change source code.

Report:

- relevant files and current behavior
- constraints and unknowns
- one or more viable directions
- the question that must be decided before planning

Keep scratch notes in this session's explicitly recorded workspace. Before the
first artifact, if none exists, allocate one with
`../planning/scripts/session-workspace.mjs` relative to this skill's canonical
directory: run it with `node`, the absolute project directory, and a short
English task description. Pi's `prewalk_workspace` tool can allocate it instead.
Retain the returned directory and pass it to Planner; never select another
session's folder by recency. End by recommending transition to Planner, not by
producing a full implementation plan.
