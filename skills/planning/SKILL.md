---
name: planning
description: Turn explored work into a small, reviewable DAG. Use after Explore and before implementation of branchy or risky work.
---

# Planner

Use this session's explicitly recorded workspace. If none exists, allocate one
with this skill's `scripts/session-workspace.mjs` after resolving the installed
skill's canonical directory:

```sh
node /absolute/planning/scripts/session-workspace.mjs /absolute/project plan-isolation
```

Replace the paths and short English task description with actual values. Retain
the returned absolute directory for this session; Pi's `prewalk_workspace` tool
can allocate it instead. Do not allocate again on each turn or choose the latest
folder. A resumed session uses its own recorded path.

Write the plan to `<session-workspace>/workflow-plan.md`, preserving earlier
approved plans when starting an independent task in the same session. Plans use
Japanese headings, explanatory prose, and diagram labels; paths, commands, and
identifiers retain their original form. Keep the plan concise and reviewable.
For work with dependencies, include Mermaid DAG nodes, their order, and a
verification method per node.

```mermaid
flowchart LR
  a[調査] --> b[実装]
  b --> c[検証]
```

Do not edit product code. Present the exact plan path and wait for a human to
approve it. Pass that path and the workspace to Worker only after approval.
