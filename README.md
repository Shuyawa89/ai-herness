# Personal AI Harness

[English](README.en.md) | 日本語

Claude Code、Codex、Pi で共有する個人用の指示と Agent Skills。

## 管理するもの

- `AGENTS.md`: グローバル指示の単一の source of truth。
- `skills/`: Agent Skills の `SKILL.md` 形式に沿った共有 Skill の正本。必要な Codex policy metadata もここに置く。
- `skill-variants/explicit/`: 明示呼び出し限定 Skill に `disable-model-invocation: true` を加えた Claude Code / Pi 向け variant。`SKILL.md` と正本の一致はテストで検証する。
- `extensions/`: バージョン管理された Pi extension。Pi が自動読込する。
- `bootstrap`: 新しいマシン向けの安全で再現可能なセットアップ。

bootstrap が接続するもの:

```text
~/.claude/CLAUDE.md   -> <repo>/AGENTS.md
~/.codex/AGENTS.md    -> <repo>/AGENTS.md
~/.pi/agent/AGENTS.md -> <repo>/AGENTS.md

# 通常の共有 Skill
~/.claude/skills/<name> -> <repo>/skills/<name>
~/.codex/skills/<name>  -> <repo>/skills/<name>
~/.agents/skills/<name> -> <repo>/skills/<name>

# 明示呼び出し限定の Skill
~/.claude/skills/<name> -> <repo>/skill-variants/explicit/<name>
~/.codex/skills/<name>  -> <repo>/skills/<name>
~/.agents/skills/<name> -> <repo>/skill-variants/explicit/<name>

~/.pi/agent/extensions/ai-harness-prewalk.ts
  -> <repo>/extensions/pi-prewalk.ts
```

bootstrap の allowlist にある Skill だけを配布する。通常は `skills/<name>` の正本を3ツールへリンクし、明示呼び出し限定の Skill だけ上記の tool-specific source を使う。Pi は `~/.agents/skills` を直接読む。Codex の system skill には触れず、同名の harness skill が競合した場合のみインストールを停止する。

## 別マシンでのセットアップ

```bash
git clone <YOUR_REPOSITORY_URL> ~/ai-harness
cd ~/ai-harness
./bootstrap --dry-run
./bootstrap
./bootstrap --check
```

推奨 clone 先は `~/ai-harness` だが、配置場所に依存しない動作をする。

## 安全な動作

- 既存の指示ファイルは、リンク作成前にタイムスタンプ付きでバックアップする。
- 同名の既存 skill は、内容がリポジトリのコピーと一致する場合のみリンクする。
- 同名でも内容が異なる場合は、変更を行う前に preflight 全体を停止する。
- インストール失敗時はリンクをロールバックし、その実行で移動したファイルを復元する。
- すべて接続済みの状態で再実行すると no-op になる。
- リポジトリから削除された skill のリンクは検出され、次回インストール時にバックアップして削除する。

バックアップはリポジトリ外の次の場所に保存される:

```text
${XDG_STATE_HOME:-~/.local/state}/ai-harness/backups/
```

アトミックな移動のため、バックアップディレクトリは置き換え対象の既存設定と同じファイルシステム上にある必要がある。`XDG_STATE_HOME` が別ボリュームを指す場合は、bootstrap 実行時に `AI_HARNESS_STATE_ROOT` をホームボリューム上のプライベートディレクトリへ設定する。

bootstrap は管理リンクの manifest を `${XDG_STATE_HOME:-~/.local/state}/ai-harness/managed-links.tsv` に保存し、削除済み skill を安全に検出できるようにしている。

認証情報、auth ファイル、session、モデル設定、hooks、ツール固有のランタイム資産は、このリポジトリにコピーしない。バージョン管理された extension のソースはここに置いてよく、bootstrap がレビュー済みの Prewalk extension を Pi のグローバル extension ディレクトリへ symlink する。

サードパーティの素材とライセンス詳細は `THIRD_PARTY_NOTICES.md` に記録する。

## 共有 Skill の追加・更新

1. `skills/<name>/SKILL.md` と必要なファイルを正本として追加・更新する。
2. 明示呼び出し限定にする場合は、Codex 用の `agents/openai.yaml` と、Claude Code / Pi 用の `skill-variants/explicit/<name>` を追加・更新する。variant の `SKILL.md` は制御用 frontmatter 以外が正本と一致するように保つ。
3. シークレット、危険なコマンド、マシン固有のパスがないか確認する。
4. `./bootstrap` を実行して不足しているツールごとのリンクを作る。
5. `./bootstrap --check` を実行してから、レビュー済みの変更をコミットする。

一部の skill インストーラはリポジトリ外に独自の lock ファイルを持ち、更新時に管理リンクを置き換えることがある。`--check` が drift を検出したら、上流の変更を確認し、意図したバージョンを `skills/` に取り込んでから bootstrap を再実行する。

## 理解・設計確認 Skill

`understand` と `design-check` は通常の依頼では自動使用せず、必要なときだけ明示的に呼び出す。

Codex は `skills/<name>` の正本を読み、`agents/openai.yaml` の `allow_implicit_invocation: false` で暗黙呼び出しを無効にする。Claude Code と Pi は、`disable-model-invocation: true` を追加した `skill-variants/explicit/<name>` を読む。この variant の `SKILL.md` は、制御用 frontmatter を除いて正本と一致することをテストで検証する。

- `understand`: 分からない実装や概念を、目的と具体例から始めて必要最小限の技術要素へ段階的に説明する。
- `design-check`: コードを書く前に、完成条件、責務、データフロー、設計判断、見落としやすい懸念を簡潔に整理する。

| ツール | `understand` の例 | `design-check` の例 |
| --- | --- | --- |
| Claude Code | `/understand Transactionをここに置く理由` | `/design-check このIssueの実装方針` |
| Codex | `$understand Transactionをここに置く理由` | `$design-check このIssueの実装方針` |
| Pi | `/skill:understand Transactionをここに置く理由` | `/skill:design-check このIssueの実装方針` |

Pi 向けの variant は `~/.agents/skills` にリンクされ、Pi がそこから直接読み込む。

## Pi Prewalk

Prewalk は、frontier モデル（first model）に調査・具体計画・1 回の実コード変更を行わせた後、**同じ Pi session 内で**より安価な worker モデル（second model）へ切り替える。

ルートはマシン固有の設定で、Git の外にある harness ディレクトリ直下の `prewalk.json` に置く（`.gitignore` 対象）。作成するタイミングは任意だが、Prewalk を使いたい最初のタスクの前が目安。ファイルが存在しない間は `/prewalk` に明示的な引数が必要で、`./bootstrap` はファイルが見つからないたびにリマインダーを出す:

```json
{
  "first_model": "<provider/first-model>",
  "second_model": "<provider/second-model>"
}
```

対象プロジェクトのディレクトリから、普通に Pi を起動する:

```bash
pi
```

タスクを入力する前に `/prewalk` を実行する。ルートはローカル設定から解決され、`/prewalk <second>` または `/prewalk <first> <second>` で 1 回だけ上書き、`/prewalk off` で解除できる。


選択するモデルは認証済みで `pi --list-models` に表示されている必要がある。プロバイダ定義と認証情報は `~/.pi/agent/models.json` と Pi の credential storage に置き、このリポジトリには絶対に置かない。Prewalk は下記のセッション専用フォルダに計画と作業用ファイルを書く。`.temp-local/` は Git のグローバル ignore 対象。

`skills/harness-workflow/` は、記事から再利用できる役割分担（Explore、Planner、Worker、Critic、Promoter）をまとめたもの。配布する Skill は `bootstrap` 冒頭の allowlist のみ。追加したい skill はそこに名前を加える。通常は正本をそのまま配布し、明示呼び出し限定の Skill には上記の tool-specific source を使う。ハーネスは環境固有の skill もモデル選択も Git に含まない。


現在の依頼の言葉が役割と Skill を一つ選ぶ。`/workflow` のようなコマンド語彙は強制しない。Planner の承認と完了判断は会話の中で人間が行う gate であり、実装フェーズへ切り替える。

## セッション専用の作業フォルダ

計画・調査メモ・検証結果は、対象プロジェクト内のセッション専用フォルダに保存する。

```text
.temp-local/sessions/
  20261026-143052-plan-isolation/
    workflow-plan.md
    notes.md
  20261026-143052-plan-isolation-2/
    workflow-plan.md
```

名前はローカル時刻のタイムスタンプと、作業内容を表す短い英語の名前を組み合わせる。同名の場合だけ `-2`、`-3` と連番を付ける。UUIDは使わない。エージェントが Planning スキルの `scripts/session-workspace.mjs` を `node` で実行し、プロジェクトの絶対パスと短い作業名を渡す。フォルダ作成は排他的に行うため、複数セッションが同時に同じ名前を選んでも既存ファイルを上書きしない。追加パッケージは不要で、Node.js を利用する。

Pi ではモデルが `prewalk_workspace` ツールに短い作業名を渡し、同じ作成処理を利用する。保存先を Pi のセッション履歴に記録するため、再度の `/prewalk`、会話の圧縮、セッション再開でも同じフォルダを使う。独立した新規セッションや fork では別フォルダを作る。最初のモデルの編集制限では、別セッションの計画でソース編集の条件を満たしたり、別セッションの作業用ファイルへ書き込んだりできない。

通常のスキルでは、会話と引き継ぎ情報に保存先の絶対パスを保持する。再開時は「`.temp-local/sessions/20261026-143052-plan-isolation/workflow-plan.md` の承認済み計画を続けて」のように対象を明示する。パスが不明ならそのセッションの記録から復元し、最新フォルダの自動選択はしない。同じセッションの別タスクで新しい計画を書く場合は、以前の承認済み計画を保持する。

計画の見出し・説明・図のラベルは日本語にする。パス・コマンド・識別子は元の表記を維持する。既存の `.temp-local/workflow-plan.md` などは自動移動・削除しない。この仕組みは作業用ファイルの分離であり、ソースコードの同時編集には worktree などによる別の分離が必要。

検証: `node --test tests/session-workspace_test.mjs`、`node tests/prewalk_test.mjs`、`node --test tests/prewalk-adapter_test.mjs`、`bash tests/bootstrap_test.sh`。

## 既存のマシン固有設定

bootstrap は `~/.codex/config.toml`、Claude の設定、Pi の設定、認証、hooks、agents、prompts を意図的に変更しない。追加するのはレビュー済みの共有 Skill とレビュー済みの Pi Prewalk extension の symlink のみ。リポジトリ固有の `AGENTS.md` と `CLAUDE.md` は、各ツールの通常の優先順位ルールに従って適用される。

このリポジトリ内で作業するとき、同じ `AGENTS.md` がグローバルとプロジェクトの両方として検出されることがある。これは無害だが、この harness の通常の作業場所は他のリポジトリである。

## タスクのライブダッシュボード

`skills/task-dashboard/` は、普段の Pi・Claude Code・Codex セッションから利用する共通ダッシュボードです。[スキル](skills/task-dashboard/SKILL.md)を読み込むと、AI がタスクを登録してローカル URL を提供します。独立した複数タスクを左の一覧で切り替え、計画・担当・モデル・経過時間・履歴・作業ディレクトリ・ブランチ・worktree 情報を確認できます。専用のエージェント起動コマンドや拡張は不要です。

共通ツールは Go の標準ライブラリで実装され、ビルド後は Go・Python の実行環境を必要としません。ビルドは `bash skills/task-dashboard/scripts/build.sh`。既存の Go、または mise の Go 1.27.2 を利用し、既定では `~/.local/state/task-dashboard/bin/task-dashboard` に出力します。ビルド済みファイルは OS・CPU ごとに必要です。現在のプロセス管理・ロックは macOS/Linux 対応です。

進捗は `~/.local/state/task-dashboard/`（`--root` で変更可能）にタスク別で保存されます。`task-dashboard server start` はセッションから独立したローカルサーバーを起動し、`server status`・`server stop` で確認・停止できます。OS の自動起動設定は追加しません。サーバーを止めても進捗ファイルは残り、通常の更新処理が勝手に起動し直すことはありません。停止すると全タスクの画面配信が止まります。

調整役は子を起動前に登録し、書き込み可能な子も短いコマンドで自分の情報を更新します。ロックとファイル置換が同時更新を保護し、作業場所を渡すと Git 情報を取得します。ブラウザーはタスク一覧を低頻度、選択中の詳細を約1秒ごとに読み込み、モデルを呼び出しません。最終回答の直前に `finish` でタスクと調整役をまとめて更新し、結果報告は完了、質問・承認待ちは確認待ちとして記録します。一覧は「すべて／実行中／確認が必要／完了済み」で絞り込めます。表示は報告された進捗であり、終了コマンドの呼び忘れや強制終了を自動検知するものではありません。[サンプルデータ](skills/task-dashboard/assets/progress.example.json)は架空の内容です。従来の単一 JSON・静的サーバー方式と Python 更新ヘルパーも利用できます。

`task-dashboard` は bootstrap の共有スキル配布対象です。通常のセットアップで Pi・Claude Code・Codex のスキル配置先へリンクされます。検証: `node --test tests/dashboard-template.test.mjs tests/dashboard-multi.test.mjs`、`python3 tests/dashboard-reporting_test.py`、`cd skills/task-dashboard && mise exec go@1.27.2 -- go test ./...`。
