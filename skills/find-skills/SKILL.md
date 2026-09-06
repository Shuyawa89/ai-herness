---
name: find-skills
description: Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.
---

# Find Skills

This skill helps you discover and install skills from the open agent skills ecosystem.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

## What is the Skills CLI?

The Skills CLI (`pnpm dlx skills@1.4.1`) is a package manager for the open agent skills ecosystem. The pinned CLI version makes discovery reproducible; update it only after reviewing the release.

**Key commands:**

- `pnpm dlx skills@1.4.1 find [query]` - Search for skills interactively or by keyword
- `pnpm dlx skills@1.4.1 check` - Check for skill updates
- `pnpm dlx skills@1.4.1 update` - Review available updates; do not apply them without inspecting the diff

**Browse skills at:** https://skills.sh/

## How to Help Users Find Skills

### Step 1: Understand What They Need

When a user asks for help with something, identify:

1. The domain (e.g., React, testing, design, deployment)
2. The specific task (e.g., writing tests, creating animations, reviewing PRs)
3. Whether this is a common enough task that a skill likely exists

### Step 2: Check the Leaderboard First

Before running a CLI search, check the [skills.sh leaderboard](https://skills.sh/) to see if a well-known skill already exists for the domain. The leaderboard ranks skills by total installs, surfacing the most popular and battle-tested options.

For example, top skills for web development include:
- `vercel-labs/agent-skills` — React, Next.js, web design (100K+ installs each)
- `anthropics/skills` — Frontend design, document processing (100K+ installs)

### Step 3: Search for Skills

If the leaderboard doesn't cover the user's need, run the find command:

```bash
pnpm dlx skills@1.4.1 find [query]
```

For example:

- User asks "how do I make my React app faster?" → `pnpm dlx skills@1.4.1 find react performance`
- User asks "can you help me with PR reviews?" → `pnpm dlx skills@1.4.1 find pr review`
- User asks "I need to create a changelog" → `pnpm dlx skills@1.4.1 find changelog`

### Step 4: Verify Quality Before Recommending

**Do not recommend a skill based solely on search results.** Always verify:

1. **Source contents** — Read `SKILL.md`, scripts, hooks, and referenced files before recommending or installing.
2. **Pinned revision** — Resolve and report the exact source commit; do not rely on a moving branch for installation.
3. **Permissions and commands** — Identify network access, credential use, destructive actions, and external writes.
4. **License and provenance** — Verify that redistribution and local modification are permitted.
5. **Reputation signals** — Use install count, maintainer identity, and stars only as supporting signals, never as a security review.

### Step 5: Present Options to the User

When you find relevant skills, present them to the user with:

1. The skill name and what it does
2. The install count and source
3. The install command they can run
4. A link to learn more at skills.sh

Example response:

```
I found a skill that might help! The "react-best-practices" skill provides
React and Next.js performance optimization guidelines from Vercel Engineering.
(185K installs)

To install it:
pnpm dlx skills@1.4.1 add vercel-labs/agent-skills@react-best-practices

Learn more: https://skills.sh/vercel-labs/agent-skills/react-best-practices
```

### Step 6: Offer to Install

Install only after the user explicitly approves the reviewed source and revision. Do not skip confirmation prompts or perform unattended global installation.

```bash
pnpm dlx skills@1.4.1 add <owner/repo@skill>
```

After installation, copy the reviewed standard-format skill into `~/ai-harness/skills/`, run `~/ai-harness/bootstrap`, and review the resulting Git diff before committing it.

## Common Skill Categories

When searching, consider these common categories:

| Category        | Example Queries                          |
| --------------- | ---------------------------------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code Quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## Tips for Effective Searches

1. **Use specific keywords**: "react testing" is better than just "testing"
2. **Try alternative terms**: If "deploy" doesn't work, try "deployment" or "ci-cd"
3. **Check popular sources**: Many skills come from `vercel-labs/agent-skills` or `ComposioHQ/awesome-claude-skills`

## When No Skills Are Found

If no relevant skills exist:

1. Acknowledge that no existing skill was found
2. Offer to help with the task directly using your general capabilities
3. Suggest the user could create their own skill with the pinned CLI

Example:

```
I searched for skills related to "xyz" but didn't find any matches.
I can still help you with this task directly! Would you like me to proceed?

If this is something you do often, you could create your own skill:
pnpm dlx skills@1.4.1 init my-xyz-skill
```
