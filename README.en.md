# Personal AI Harness

English | [日本語](README.md)

Shared personal instructions and Agent Skills for Claude Code, Codex, and Pi.

## What is managed

- `AGENTS.md`: the single source of truth for global instructions.
- `skills/`: canonical shared skills using the Agent Skills `SKILL.md` format, including Codex policy metadata where needed.
- `skill-variants/explicit/`: Claude Code and Pi variants that add `disable-model-invocation: true` to explicit-only skills. Tests enforce `SKILL.md` parity with the canonical skills.
- `extensions/`: versioned Pi extensions, loaded automatically by Pi.
- `bootstrap`: safe, repeatable setup for a new machine.

The bootstrap script connects:

```text
~/.claude/CLAUDE.md   -> <repo>/AGENTS.md
~/.codex/AGENTS.md    -> <repo>/AGENTS.md
~/.pi/agent/AGENTS.md -> <repo>/AGENTS.md

# Ordinary shared skills
~/.claude/skills/<name> -> <repo>/skills/<name>
~/.codex/skills/<name>  -> <repo>/skills/<name>
~/.agents/skills/<name> -> <repo>/skills/<name>

# Explicit-only skills
~/.claude/skills/<name> -> <repo>/skill-variants/explicit/<name>
~/.codex/skills/<name>  -> <repo>/skills/<name>
~/.agents/skills/<name> -> <repo>/skill-variants/explicit/<name>

~/.pi/agent/extensions/ai-harness-prewalk.ts
  -> <repo>/extensions/pi-prewalk.ts
```

Only skills on the bootstrap allowlist are distributed. Normally, all three tools receive the canonical `skills/<name>` directory; only explicit-only skills use the tool-specific sources shown above. Pi reads `~/.agents/skills` directly. Codex system skills remain untouched; only a same-name harness-skill conflict stops installation.

## Set up another machine

```bash
git clone <YOUR_REPOSITORY_URL> ~/ai-harness
cd ~/ai-harness
./bootstrap --dry-run
./bootstrap
./bootstrap --check
```

The script is location-independent even though `~/ai-harness` is the recommended clone path.

## Safety behavior

- Existing instruction files are moved to a timestamped backup before links are created.
- An existing same-name skill is linked only when its contents match the repository copy.
- A different same-name skill stops the entire preflight before any change is made.
- A failed installation rolls back links and restores files moved during that run.
- Re-running `./bootstrap` is a no-op when everything is already connected.
- Links for skills removed from the repository are detected, backed up, and removed on the next install.

Backups are stored outside the repository under:

```text
${XDG_STATE_HOME:-~/.local/state}/ai-harness/backups/
```

For atomic moves, the backup directory must be on the same filesystem as the existing configuration being replaced. If `XDG_STATE_HOME` points to another volume, set `AI_HARNESS_STATE_ROOT` to a private directory on the home volume for the bootstrap run.

The bootstrap also stores its managed-link manifest at `${XDG_STATE_HOME:-~/.local/state}/ai-harness/managed-links.tsv` so removed skills can be detected safely.

Tool credentials, auth files, sessions, model settings, hooks, and tool-specific runtime assets are never copied into this repository. Versioned extension source is safe to keep here; bootstrap symlinks the reviewed Prewalk extension into Pi's global extension directory.

Third-party material and its license details are recorded in `THIRD_PARTY_NOTICES.md`.

## Add or update a shared skill

1. Add or update the canonical `skills/<name>/SKILL.md` and its supporting files.
2. For an explicit-only skill, add or update its Codex `agents/openai.yaml` and Claude Code / Pi `skill-variants/explicit/<name>`. Keep the variant's `SKILL.md` identical to the canonical skill except for the control frontmatter.
3. Review the skill for secrets, unsafe commands, and machine-specific paths.
4. Run `./bootstrap` to create missing per-tool links.
5. Run `./bootstrap --check`, then commit the reviewed change.

Some skill installers maintain their own lock files outside this repository and may replace a managed link during an update. If `--check` detects drift, review the upstream change, copy the intended version into `skills/`, and run the bootstrap again.

## Understanding and design-check skills

`understand` and `design-check` are never selected automatically for ordinary requests. Invoke them explicitly when needed.

Codex reads the canonical `skills/<name>` directory and disables implicit invocation through `allow_implicit_invocation: false` in `agents/openai.yaml`. Claude Code and Pi read `skill-variants/explicit/<name>`, which adds `disable-model-invocation: true`. Tests verify that each variant's `SKILL.md` otherwise matches its canonical skill.

- `understand`: explains an unfamiliar implementation or concept progressively, starting with the purpose and one concrete example before introducing the minimum technical detail.
- `design-check`: concisely identifies the end state, responsibilities, data flow, design decisions, and likely blind spots before any code is written.

| Tool | `understand` example | `design-check` example |
| --- | --- | --- |
| Claude Code | `/understand Why is the transaction here?` | `/design-check Review the approach for this issue` |
| Codex | `$understand Why is the transaction here?` | `$design-check Review the approach for this issue` |
| Pi | `/skill:understand Why is the transaction here?` | `/skill:design-check Review the approach for this issue` |

The Pi variants are linked into `~/.agents/skills`, which Pi reads directly.

## Pi Prewalk

Prewalk is a versioned Pi extension that hands off from frontier (Frontier) exploration, planning, and one representative initial code change to a cheaper model (Cheap) in the **same Pi session**. Deterministic routing can return to Frontier for reviews during implementation: a pass unlocks the next phase, while a repair returns Cheap to that phase. This automatic routing is Pi-specific; it does not automatically switch models in Claude Code or Codex.

The route is machine-local and lives outside Git as `prewalk.json` in the harness directory root (gitignored). Create it whenever you adopt Prewalk; the recommended timing is before the first task you want to hand off. Until it exists, `/prewalk` needs explicit model arguments, and `./bootstrap` prints a reminder on each run while the file is missing:

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

The legacy `first_model` / `second_model` names remain supported as aliases for `frontier_model` / `cheap_model`. Conflicting values for an alias pair are rejected. Existing one-invocation overrides, `/prewalk <second>` and `/prewalk <first> <second>`, remain supported.

From the target project directory, start Pi normally:

```bash
pi
```

Then run `/prewalk` before submitting the task. It resolves the route from the local config; `/prewalk <second>` or `/prewalk <first> <second>` overrides it for one invocation, and `/prewalk off` disarms it.

The selected models must already be authenticated and appear in `pi --list-models`. Provider definitions and credentials belong in `~/.pi/agent/models.json` and Pi's credential storage, never in this repository. Prewalk writes a human-facing plan view and scratch artifacts under `.temp-local/` in the target project; this directory is globally ignored by Git.

### Prewalk lifecycle and boundaries

- Frontier first inspects repository instructions, README files, CI/build configuration, and tests to propose the scope, meaningful phases, acceptance criteria, and appropriate checks for each phase. Users do not need to enumerate files or test commands up front. A human approves the initial plan and hard boundary before source changes begin.
- The **hard boundary** is the approved outcome, constraints, protected areas, and permitted scope. **Soft estimates** include expected files or steps; Frontier may refine them during work as long as the hard boundary is unchanged. Expanding the hard boundary requires a proposal and explicit human approval.
- A failed Git worktree observation stops routing rather than pretending the tree is clean. For phases without runnable checks, the plan names concrete repository artifact paths; `prewalk_checkpoint` `progress.evidence` observes their existence. Existence alone is not proof of correctness. Cheap implements, reports TODO progress, and uses ordinary tools. With the default `milestone_review: true`, Frontier automatically reviews a phase at a tool-batch boundary when its TODOs are reported ready, dependencies are satisfied, and required validation has fresh, observed results. Readiness schedules a review; it does not establish semantic correctness. A Frontier pass advances to the next phase; a repair returns Cheap to the same phase. When the last-phase and final-review conditions are ready together, they are coalesced into one visit.
- There are six routing trigger types: (1) a detectable plan deviation, (2) consecutive failures of the same identified validation check, (3) soft-scope expansion within the approved boundary, (4) no-progress tool churn, (5) phase readiness from TODOs and fresh validation results, and (6) final-review readiness. Failure and churn triggers have finite thresholds. Defaults: `failure_threshold: 2`, `tool_churn_threshold: 6`, `max_escalations: 8`, `max_retries: 6`, `max_steps: 100`, `milestone_review: true`, and `final_review: true`. Reaching a limit stops explicitly; required reviews are not silently skipped.
- A successful built-in `bash` invocation exactly matching a planned check can provide fresh validation evidence. Failed built-in `bash` results lack a trustworthy numeric exit code; use `prewalk_validate` for structured failures and bounded diagnostic output. Ordinary `bash` and other normal tools remain available; there is no blanket command allowlist. Known violations are blocked by targeted preflight checks, and shell effects are observed after the tool batch and may trigger review. This cannot prevent every side effect in advance; Prewalk is neither automatic rollback nor an OS sandbox. Existing approval requirements for destructive operations still apply.
- Cheap requests a hard-boundary expansion by routing to Frontier; Frontier proposes it and the human approves it. `/prewalk status` shows the run state; `/prewalk approve <proposal-id>` approves the displayed current proposal (for example, the plan, a hard-boundary change, or final completion). `/prewalk resume` explicitly resumes a paused run, and `/prewalk off` disarms routing. Terminal stopped runs cannot be resumed; start a new task after addressing the stop reason. Human approval remains the completion gate even after a review passes.
- Non-context session custom entries are the canonical structured TaskState and audit record. While routing is active, `.temp-local/workflow-plan.md` is a human-facing view generated from that state, not an independent source of authority. Escalation retains the same session trajectory while rebuilding bounded relevant context. There is no guarantee that a provider switch preserves a model's private internal state.

Claude Code and Codex can follow the same planning and approval principles manually, but they do not have automatic routing, and a separate model session is not guaranteed to share the same conversation trajectory.

`skills/harness-workflow/` captures the article's reusable role split: Explore, Planner, Worker, Critic, and Promoter. Only the Skill allowlist at the top of `bootstrap` is linked into each tool; add a name there to distribute another skill. Canonical sources are used by default, while explicit-only skills use the tool-specific sources described above. The harness ships no environment-specific skills or model choices.

The current request's language selects one role and one Skill; the harness does not force a remembered `/workflow` command vocabulary. Planner approval and final completion remain conversational human gates. For substantial Pi implementation work, run `/prewalk` before the task to use the frontier-to-worker handoff.

## Existing machine-specific configuration

The bootstrap deliberately does not modify `~/.codex/config.toml`, Claude settings, Pi settings, authentication, hooks, agents, or prompts. It adds only the reviewed shared Skills and the reviewed Pi Prewalk extension as symlinks. Repository-specific `AGENTS.md` and `CLAUDE.md` files continue to apply according to each tool's normal precedence rules.

When working inside this repository, the same `AGENTS.md` may be discovered once globally and once as project guidance. This is harmless, but other repositories are the normal working location for this harness.
