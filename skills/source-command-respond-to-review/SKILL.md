---
name: "source-command-respond-to-review"
description: "Respond to PR review comments after addressing them"
---

# source-command-respond-to-review

Use this skill when the user asks to run the migrated source command `respond-to-review`.

## Command Template

# Respond to PR Review

Automatically respond to PR review comments after addressing the issues. This command:

1. Gets the current PR for the branch
2. Fetches all review comments
3. Categorizes comments by priority (must, should, nits)
4. Creates a structured response for addressed items

## Usage

```
/respond-to-review
```

## Workflow

1. **After addressing review comments:**
   - Make code changes as needed
   - Stage and commit the changes
   - Push to the branch

2. **Run this command:**
   - Automatically categorizes comments
   - Generates response for each addressed item

3. **Response Format:**

```markdown
## レビューコメントへの対応

### 対応必須 ([must])
#### [file]:[line]
- 対応しました。変更内容: [description]
- 対応不要と判断しました。理由: [reason]
- 今後の対応で修正します。タイミング: [when]

### パフォーマンス問題 ([should])
...

### 改善推奨 ([nits])
...
```

## Reply Categories

- **対応しました。**: Made the requested change
- **対応不要と判断しました。**: Change not needed, with reason
- **今後の対応で修正します。**: Will fix later, with timeline

## Example

```
# After making code changes
git status --short
git diff -- path/to/changed-file
git add path/to/changed-file
git commit -m "修正: レビューコメントに対応"

# Push only when the user has requested or approved it.
git push

# Then run
/respond-to-review
```

This will automatically post a formatted response to the PR.
