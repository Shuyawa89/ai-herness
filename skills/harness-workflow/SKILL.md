---
name: harness-workflow
description: Coordinate substantial work through Explore, Planner, Worker, Critic, and Promoter. Use when work needs an explicit plan, human gates, or an independent review.
---

# Harness Workflow

This Skill is a map, not a combined prompt. Select exactly one role for the
current request, then use only that role's Skill.

| User intent | Role | Skill |
|---|---|---|
| inspect, investigate, understand | Explorer | `explore` |
| approach, design, plan | Planner | `planning` |
| implement, fix, build | Worker | `worker` |
| review, check, verify | Critic | `critic` |
| announce, release notes, demo | Promoter | `promoter` |

## Flow

```text
Explorer -> Planner -> [human approves] -> Worker -> Critic
                                                ^        |
                                                +-- revise+
Critic -> Promoter (only when useful) -> [human completes]
```

Each session keeps one explicitly recorded workspace under
`.temp-local/sessions/YYYYMMDD-HHMMSS-short-description/`; numeric suffixes resolve
name collisions. Planning's allocation helper (or Pi's `prewalk_workspace` tool)
reserves a new directory atomically. Notes and verification artifacts stay there.
The Planner writes `<session-workspace>/workflow-plan.md` in Japanese and stops
for approval. Worker and Critic receive that exact path and the workspace;
restarts and context compaction reuse the session's own recorded path, never the
latest folder. Existing plans are preserved. The Worker follows the approved
plan. For a substantial Worker task in Pi, the
user may run `/prewalk`; the frontier model (first model in the machine-local
Prewalk config) makes the plan and first source change, then hands the same
session to the cheaper second model.

Do not load every role Skill preemptively. A new request starts in the role its
language indicates; it resumes a previous plan only when the user names that
plan.
