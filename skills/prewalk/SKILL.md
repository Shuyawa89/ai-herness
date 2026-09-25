---
name: prewalk
description: Use a frontier model to inspect and plan substantial work, then hand off to a cheaper model with bounded same-session reviews and repair routing in Pi.
---

# Prewalk

Prewalk keeps substantial Pi work in one session while using Frontier for repository discovery, planning, and reviews, and Cheap for routine implementation. Routing is rule-based supervision, not a semantic correctness guarantee or a security sandbox.

## When to use

- A feature, refactor, or unfamiliar area benefits from repository exploration and a concrete multi-step plan.
- The implementation can proceed on Cheap with bounded Frontier reviews.
- Avoid it for trivial work or tasks where every step needs Frontier-level judgment.

## Pi lifecycle

1. Arm `/prewalk` before submitting the task. Frontier inspects repository guidance, README files, CI/build configuration, and tests to discover a suitable scope, phases, acceptance criteria, and phase-appropriate validation checks. The user need not enumerate expected files or test commands.
2. Frontier proposes a structured plan with a **hard boundary** (approved outcome, constraints, protected areas, and permitted scope) and **soft estimates** (such as expected files or steps). Wait for human approval of the initial proposal before source changes. Frontier may refine estimates and methods inside the approved hard boundary; changing that boundary requires a new proposal and explicit human approval.
3. After approval, Frontier makes one successful representative source-code change. Prewalk then switches to Cheap in the same Pi session. This one-edit rule applies only to the initial handoff, not later reviews.
4. Cheap implements the current phase using normal tools, updates ordinary TODO progress, and runs the discovered checks. The extension observes tool calls/results and worktree changes. It recognizes actual validation evidence only when a check can be reliably identified; unknown or ambiguous results are not passing evidence.
5. By default, phase reviews are automatic. At a completed tool-batch boundary, a phase is ready when its TODOs are reported ready, prerequisites are met, and required evidence is fresh. This readiness schedules review; it is not proof of semantic correctness. Frontier reviews the current work and evidence: a pass unlocks the next phase, while a repair returns Cheap to the same phase with pending work. The last phase and final review are coalesced when both become ready together.
6. Final review checks the current plan, diff, validation results, pending work, and deviations. A repair invalidates the prior approval and returns to Cheap; a pass reaches a human completion-approval gate, not automatic task completion.

The initial structured plan and hard boundary require human approval. `/prewalk approve <proposal-id>` approves only the displayed current proposal; it does not authorize a different or stale revision. Use `/prewalk status` to inspect state, `/prewalk resume` to explicitly resume a paused run, and `/prewalk off` to disarm routing. A terminal stopped run cannot be resumed; start a new task after addressing the stop reason. Existing zero-, one-, and two-model-argument `/prewalk` forms remain supported.

## Automatic routing triggers and limits

There are six trigger types:

1. A detectable deviation from the approved plan or hard boundary. Known violations can be blocked before execution; hard-boundary changes wait for human approval.
2. Repeated failures of the same identified validation check. Only observed outcomes count, not a model's claim or an unrelated shell error.
3. Soft-scope expansion beyond Frontier's estimates but still within the approved hard boundary; Frontier reassesses the plan.
4. Tool churn or lack of observable progress, treated as a bounded heuristic rather than proof of being stuck.
5. Phase readiness from TODO progress plus fresh required evidence.
6. Final-review readiness.

The defaults are finite and configurable:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `failure_threshold` | `2` | Consecutive observed failures of the same identified check before escalation |
| `tool_churn_threshold` | `6` | Matching/no-progress events in the bounded recent window |
| `max_escalations` | `8` | Maximum Cheap-to-Frontier visits, including phase/final reviews and repair reviews |
| `max_retries` | `6` | Cumulative retry attempts for failed checks or repeated rejected operations |
| `max_steps` | `100` | Total model turns; not a phase-review timer |
| `milestone_review` | `true` | Automatically review ready phases |
| `final_review` | `true` | Review before human completion approval |

Successful evidence resets only the failure streak for that check. Switching models, resuming, or editing the plan does not reset lifetime limits. If a required action cannot continue within a limit, stop visibly instead of silently skipping a review or looping.

## Tools, validation, and scope limits

Cheap retains ordinary `bash` and normal tool use; Prewalk does not impose a blanket command allowlist. It uses targeted preflight checks for known violations, then observes shell/worktree effects after the tool batch. A discovered side effect can trigger review but was not necessarily blocked in advance. This is not an OS sandbox, universal shell parser, or automatic rollback. Existing approval requirements for destructive operations still apply.

Frontier discovers checks from repository sources and associates relevant ones with phases. Phases without runnable checks must name repository-relative artifact paths in `evidenceRequired`; Cheap records observed existing files using `prewalk_checkpoint` progress `evidence`. File existence schedules review but is not proof of correctness. Git worktree observation failures stop routing. An exact successful built-in `bash` invocation can provide fresh evidence; its failed result does not expose a reliable numeric exit code. Use the optional `prewalk_validate` tool for structured failed-check evidence and bounded diagnostic output. An unknown, skipped, stale, or ambiguous result cannot satisfy a required check. This routing predicate uses reported TODO progress and measured evidence; it does not establish that code is semantically correct or detect every architectural/API change.

## Configuration and portability

Configuration is machine-local at `<harness-root>/prewalk.json` (the root of this harness checkout), not `~/.pi/agent/prewalk.json` and not the target project. It is gitignored; do not put credentials or provider secrets in it. `frontier_model` / `cheap_model` are the current names. Legacy `first_model` / `second_model` remain supported aliases; conflicting values for an alias pair are rejected. The model IDs must be available to Pi. Example:

```json
{
  "frontier_model": "<provider/frontier-model>",
  "cheap_model": "<provider/cheap-model>",
  "failure_threshold": 2,
  "tool_churn_threshold": 6,
  "max_escalations": 8,
  "max_retries": 6,
  "max_steps": 100,
  "milestone_review": true,
  "final_review": true
}
```

Other bounded settings (including scope expansion, context/output budgets, churn window, and command timeout) must use finite validated values; check the extension's supported configuration before setting them.

Automatic same-session model routing is supported only by the Pi extension. Claude Code and Codex can follow the planning and approval principles manually, but do not promise automatic model switching or shared cross-session context.

## Durable state and context

The canonical TaskState and routing audit are persisted as non-context Pi session custom entries. While routing is active, `.temp-local/workflow-plan.md` is a human-facing generated view of accepted structured state, not a separate authority; editing the Markdown does not change permissions or the approved contract. Outside active routing, the repository's ordinary instruction-driven plan workflow remains in effect.

Escalation retains the same session trajectory and constructs bounded relevant context from the goal, constraints, current plan/state, reason, recent evidence, and scoped file references. Optional evidence may be shortened; mandatory constraints are not silently dropped. A session/model change cannot guarantee preservation of a provider's private reasoning or other internal cross-provider state.

Do not put API keys, provider configuration, or session logs in the harness repository.
