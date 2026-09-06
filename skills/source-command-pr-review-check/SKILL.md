---
name: "source-command-pr-review-check"
description: "現在のPRのレビューコメントを取得し、対応が必要か判断して報告"
---

# source-command-pr-review-check

Use this skill when the user asks to run the migrated source command `pr-review-check`.

## Command Template

PRのレビューコメントを取得して、対応が必要かどうかを判断します。

## 手順

1. 現在のブランチに関連するPRを取得
2. レビューコメントを取得
3. 各コメントを分析して以下を判断:
   - [must] 重大な問題 → 対応必須
   - [should] 推奨される改善 → 検討推奨
   - [question] 確認事項 → 回答が必要
   - [nits] 小さな改善点 → 任意対応
   - [nr] 返信不要 → 対応不要

4. 以下の形式でユーザーに報告:

```
## PRレビューチェック結果

PR: #<番号> - <タイトル>
レビューア: <名前>
コメント数: <件数>

### 対応必須 ([must])
<件数>件
- <ファイル>: <内容>

### 検討推奨 ([should])
<件数>件
- <ファイル>: <内容>

### 確認必要 ([question])
<件数>件
- <ファイル>: <内容>

### 任意対応 ([nits])
<件数>件
- <ファイル>: <内容>

### 対応不要 ([nr])
<件数>件

## 推奨アクション
<アクション内容>
```

## 使用方法

```
/pr-review-check
```

## 注意事項

- GitHub CLI (gh) が必要
- 現在のブランチに関連するPRを取得
- 未解決のコメントのみを対象とする
