# Personal AI Harness

[English](README.en.md) | 日本語

Claude Code、Codex、Pi で共有する個人用の指示と Agent Skills。

## 管理するもの

- `AGENTS.md`: グローバル指示の単一の source of truth。
- `skills/`: Agent Skills の `SKILL.md` 形式に沿ったクロスエージェント Skill。
- `extensions/`: バージョン管理された Pi extension。Pi が自動読込する。
- `bootstrap`: 新しいマシン向けの安全で再現可能なセットアップ。

bootstrap が接続するもの:

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

Pi は `~/.agents/skills` を直接読む。Codex の system skill には触れず、同名の harness skill が競合した場合のみインストールを停止する。

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

1. `skills/<name>/SKILL.md` と必要なファイルを追加・更新する。
2. シークレット、危険なコマンド、マシン固有のパスがないか確認する。
3. `./bootstrap` を実行して不足しているツールごとのリンクを作る。
4. `./bootstrap --check` を実行してから、レビュー済みの変更をコミットする。

一部の skill インストーラはリポジトリ外に独自の lock ファイルを持ち、更新時に管理リンクを置き換えることがある。`--check` が drift を検出したら、上流の変更を確認し、意図したバージョンを `skills/` に取り込んでから bootstrap を再実行する。

## Pi Prewalk

Prewalk は、frontier モデル（first model）に調査・具体計画・1 回の実コード変更を行わせた後、**同じ Pi session 内で**より安価な worker モデル（second model）へ切り替える。

ルートはマシン固有の設定で、Git の外にある `~/.pi/agent/prewalk.json` に置く。作成するタイミングは任意だが、Prewalk を使いたい最初のタスクの前が目安。ファイルが存在しない間は `/prewalk` に明示的な引数が必要で、`./bootstrap` はファイルが見つからないたびにリマインダーを出す:

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


選択するモデルは認証済みで `pi --list-models` に表示されている必要がある。プロバイダ定義と認証情報は `~/.pi/agent/models.json` と Pi の credential storage に置き、このリポジトリには絶対に置かない。Prewalk は対象プロジェクトの `.temp-local/` 配下に計画と scratch ファイルを書く。このディレクトリは Git のグローバル ignore 対象。

`skills/harness-workflow/` は、記事から再利用できる役割分担（Explore、Planner、Worker、Critic、Promoter）をまとめたもの。配布する Skill は `bootstrap` 冒頭の allowlist のみ。追加したい skill はそこに名前を加える。ハーネスは環境固有の skill もモデル選択も Git に含まない。


現在の依頼の言葉が役割と Skill を一つ選ぶ。`/workflow` のようなコマンド語彙は強制しない。Planner の承認と完了判断は会話の中で人間が行う gate であり、実装フェーズへ切り替える。

## 既存のマシン固有設定

bootstrap は `~/.codex/config.toml`、Claude の設定、Pi の設定、認証、hooks、agents、prompts を意図的に変更しない。追加するのはレビュー済みの共有 Skill とレビュー済みの Pi Prewalk extension の symlink のみ。リポジトリ固有の `AGENTS.md` と `CLAUDE.md` は、各ツールの通常の優先順位ルールに従って適用される。

このリポジトリ内で作業するとき、同じ `AGENTS.md` がグローバルとプロジェクトの両方として検出されることがある。これは無害だが、この harness の通常の作業場所は他のリポジトリである。
