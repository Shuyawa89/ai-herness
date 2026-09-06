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
2. Write a concrete checklist to `.temp-local/workflow-plan.md`.
3. Make exactly one non-plan code edit or write.
4. Handoff to the worker model.
5. The worker follows the checklist, verifies the result, and reports remaining risks.

The first change must be a real implementation choice, not formatting or a
placeholder. Keep the plan short, ordered, and verifiable.

## Pi: automatic handoff

Start Pi normally from the project being worked on:

```bash
pi
```

Then arm the default route:

```text
/prewalk
```

Default route:

```text
openai-codex/gpt-5.6-sol -> openrouter/z-ai/glm-5.3-flash
```

Optional routes:

```text
/prewalk openrouter/z-ai/glm-5.3-flash
/prewalk <frontier-provider/model> <worker-provider/model>
/prewalk off
```

The Pi extension blocks source-code writes before a plan, blocks a second code
mutation, and permits only read-oriented built-ins plus `edit` and `write` in
the frontier pass. It writes the plan and other scratch artifacts in
`.temp-local/`. At the end of the first successful source-code change turn, it
switches models in the same Pi session and injects a worker handoff message.

## Claude Code and Codex

Follow the same contract manually. Their normal CLI sessions do not expose Pi's
turn-level model-switch hook, so do not pretend that a fresh CLI session has the
same context. Keep the plan file and first change, then explicitly start or
select the intended worker model.

## Limits

- Prewalk is an execution handoff, not a replacement for human approval on risky work.
- Do not put API keys, provider configuration, or session logs in the harness repository.
- A model can make several read-only tool calls and write scratch files under `.temp-local/` before the first source-code change; “one action” means one source-code mutation outside `.temp-local/`.
