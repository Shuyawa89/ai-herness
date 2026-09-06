---
name: mise-add
description: Add and install new tools/languages with mise in project scope. Use when user asks to install, add, or set up a new language (Go, Rust, Python, Node, etc.) or tool (prettier, ripgrep, etc.). Handles mise use to add to .mise.toml and mise install to install. Triggers on phrases like "Xをインストールして", "add X", "install X", "miseでXを入れる".
---

# Mise Add

Add and install new tools/languages to a project using mise.

## Workflow

### 1. Check Environment

```bash
# Verify .mise.toml exists in project
ls .mise.toml || ls .config/mise.toml || ls mise.toml
```

If no config exists, create minimal `.mise.toml`:
```toml
[tools]
```

### 2. Add Tool with mise use

**Priority: LTS > latest** (when version not specified)

```bash
# Language with LTS support
mise use node@lts        # Node.js LTS
mise use python@3.12     # Python (specify minor for stability)
mise use go@latest       # Go (no LTS, use latest)
mise use rust@latest     # Rust (no LTS, use latest)
mise use ruby@latest     # Ruby

# npm tools (prefix with npm:)
mise use npm:prettier@latest
mise use npm:eslint@latest
mise use npm:typescript@latest

# With version specified by user
mise use node@20
mise use python@3.11
```

**Note**: `mise use` automatically adds the tool to `.mise.toml` AND installs it.

### 3. Verify Installation

```bash
mise ls
mise which <tool-name>
```

## Common Tools Quick Reference

| Tool | Command | Notes |
|------|---------|-------|
| Node.js | `mise use node@lts` | Use LTS for stability |
| Python | `mise use python@3.12` | Pin minor version |
| Go | `mise use go@latest` | |
| Rust | `mise use rust@latest` | |
| Ruby | `mise use ruby@latest` | |
| Bun | `mise use bun@latest` | |
| Deno | `mise use deno@latest` | |

## npm/pip/cargo Tools

```bash
# npm packages
mise use npm:prettier
mise use npm:eslint
mise use npm:tsx

# pip packages (pipx style)
mise use pipx:black
mise use pipx:ruff

# cargo packages
mise use cargo:ripgrep
mise use cargo:fd-find
```

## Examples

**User: "Goをインストールして"**
```bash
mise use go@latest
go version
```

**User: "Node.jsのLTSを入れて"**
```bash
mise use node@lts
node --version
```

**User: "prettierを追加して"**
```bash
mise use npm:prettier@latest
prettier --version
```

**User: "Python 3.11をインストールして"**
```bash
mise use python@3.11
python --version
```

## Troubleshooting

**Tool not found in mise registry:**
```bash
mise registry | grep <tool>
mise ls-remote <tool>
```

**Version not available:**
```bash
mise ls-remote node    # List all available versions
mise use node@20.10.0  # Use specific version
```

**Reinstall tools:**
```bash
mise install
```
