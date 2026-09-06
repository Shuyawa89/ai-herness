# Personal AI Harness

English | [日本語](README.md)

Shared personal instructions and Agent Skills for Claude Code, Codex, and Pi.

## What is managed

- `AGENTS.md`: the single source of truth for global instructions.
- `skills/`: cross-agent skills using the Agent Skills `SKILL.md` format.
- `extensions/`: versioned Pi extensions, loaded automatically by Pi.
- `bootstrap`: safe, repeatable setup for a new machine.

The bootstrap script connects:

```text
~/.claude/CLAUDE.md   -> <repo>/AGENTS.md
~/.codex/AGENTS.md    -> <repo>/AGENTS.md
~/.pi/agent/AGENTS.md -> <repo>/AGENTS.md

~/.claude/skills/<name> -> <repo>/skills/<name>
~/.codex/skills/<name>  -> <repo>/skills/<name>
~/.agents/skills/<name> -> <repo>/skills/<name>

~/.pi/agent/extensions/ai-harness-prewalk.ts
  -> <repo>/extensions/pi-prewalk.ts
```

Pi reads `~/.agents/skills` directly. Codex system skills remain untouched; only a same-name harness-skill conflict stops installation.

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

1. Add or update `skills/<name>/SKILL.md` and its supporting files.
2. Review the skill for secrets, unsafe commands, and machine-specific paths.
3. Run `./bootstrap` to create missing per-tool links.
4. Run `./bootstrap --check`, then commit the reviewed change.

Some skill installers maintain their own lock files outside this repository and may replace a managed link during an update. If `--check` detects drift, review the upstream change, copy the intended version into `skills/`, and run the bootstrap again.

## Pi Prewalk

Prewalk uses a frontier model for exploration, a concrete plan, and one real code mutation, then switches to a cheaper worker model in the **same Pi session**. The default route is:

```text
openai-codex/gpt-5.6-sol -> openrouter/z-ai/glm-5.3-flash
```

From the target project directory, start Pi normally:

```bash
pi
```

Then run `/prewalk` before submitting the task. Bootstrap installs the reviewed extension globally as a symlink, so ordinary Pi sessions have the command. Use `/prewalk <worker>` or `/prewalk <frontier> <worker>` to override the route, and `/prewalk off` to disarm it.

The selected models must already be authenticated and appear in `pi --list-models`. Provider definitions and credentials belong in `~/.pi/agent/models.json` and Pi's credential storage, never in this repository. Prewalk writes its plan and scratch artifacts under `.temp-local/` in the target project; this directory is globally ignored by Git.

`skills/harness-workflow/` captures the article's reusable role split: Explore, Planner, Worker, Critic, and Promoter. It is shared with Claude Code and Codex; Pi supplies the automatic Prewalk model handoff.

The current request's language selects one role and one Skill; the harness does not force a remembered `/workflow` command vocabulary. Planner approval and final completion remain conversational human gates. For substantial Pi implementation work, run `/prewalk` before the task to use the frontier-to-worker handoff.

## Existing machine-specific configuration

The bootstrap deliberately does not modify `~/.codex/config.toml`, Claude settings, Pi settings, authentication, hooks, agents, or prompts. It adds only the reviewed shared Skills and the reviewed Pi Prewalk extension as symlinks. Repository-specific `AGENTS.md` and `CLAUDE.md` files continue to apply according to each tool's normal precedence rules.

When working inside this repository, the same `AGENTS.md` may be discovered once globally and once as project guidance. This is harmless, but other repositories are the normal working location for this harness.
