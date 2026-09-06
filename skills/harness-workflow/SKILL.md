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

The Planner writes `.temp-local/workflow-plan.md` and stops for approval. The
Worker follows that approved plan. For a substantial Worker task in Pi, the
user may run `/prewalk`; it uses `gpt-5.6-sol` for the plan and first source
change, then hands the same session to `z-ai/glm-5.3-flash`.

Do not load every role Skill preemptively. A new request starts in the role its
language indicates; it resumes a previous plan only when the user names that
plan.
