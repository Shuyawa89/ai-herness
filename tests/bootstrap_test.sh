#!/usr/bin/env bash

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BOOTSTRAP="$REPO_ROOT/bootstrap"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ai-harness-tests.XXXXXX")"

cleanup() {
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/ai-harness-tests.*) rm -rf "$TEST_ROOT" ;;
    *) printf 'Refusing to clean unexpected test path: %s\n' "$TEST_ROOT" >&2 ;;
  esac
}

trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_link() {
  local link_path="$1"
  local target_path="$2"
  [ -L "$link_path" ] || fail "expected symlink: $link_path"
  [ "$(readlink "$link_path")" = "$target_path" ] || fail "unexpected target: $link_path"
}

expect_status() {
  local expected="$1"
  shift
  local actual

  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e

  [ "$actual" -eq "$expected" ] || fail "expected exit $expected, got $actual: $*"
}

run_bootstrap() {
  local user_home="$1"
  local state_root="$2"
  shift 2
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$BOOTSTRAP" "$@"
}

test_fresh_install_backup_and_idempotency() {
  local case_root="$TEST_ROOT/fresh"
  local user_home="$case_root/home"
  local state_root="$case_root/state"
  local canonical_home
  local backup_count_before
  local backup_count_after

  mkdir -p "$user_home/.claude/skills"
  canonical_home="$(cd "$user_home" && pwd -P)"
  printf '%s\n' 'legacy instructions' > "$user_home/.claude/CLAUDE.md"
  cp -R "$REPO_ROOT/skills/find-skills" "$user_home/.claude/skills/find-skills"

  run_bootstrap "$user_home" "$state_root" >/dev/null
  run_bootstrap "$user_home" "$state_root" --check >/dev/null

  assert_link "$user_home/.claude/CLAUDE.md" "$REPO_ROOT/AGENTS.md"
  assert_link "$user_home/.codex/AGENTS.md" "$REPO_ROOT/AGENTS.md"
  assert_link "$user_home/.pi/agent/AGENTS.md" "$REPO_ROOT/AGENTS.md"
  assert_link "$user_home/.pi/agent/extensions/ai-harness-prewalk.ts" "$REPO_ROOT/extensions/pi-prewalk.ts"
  assert_link "$user_home/.pi/agent/extensions/prewalk-core.mjs" "$REPO_ROOT/extensions/prewalk-core.mjs"
  assert_link "$user_home/.claude/skills/find-skills" "$REPO_ROOT/skills/find-skills"
  assert_link "$user_home/.codex/skills/find-skills" "$REPO_ROOT/skills/find-skills"
  grep -Fq "$canonical_home/.claude/CLAUDE.md" "$state_root"/backups/*/manifest.tsv || fail 'missing instruction backup manifest entry'

  backup_count_before="$(find "$state_root/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  run_bootstrap "$user_home" "$state_root" >/dev/null
  backup_count_after="$(find "$state_root/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  [ "$backup_count_before" = "$backup_count_after" ] || fail 'idempotent run created another backup'
}

test_dry_run_has_no_side_effects() {
  local case_root="$TEST_ROOT/dry-run"
  local user_home="$case_root/home"
  local state_root="$case_root/state"
  local output="$case_root/output.txt"

  mkdir -p "$user_home/.claude"
  printf '%s\n' 'legacy instructions' > "$user_home/.claude/CLAUDE.md"
  run_bootstrap "$user_home" "$state_root" --dry-run > "$output"

  [ -f "$user_home/.claude/CLAUDE.md" ] || fail 'dry-run replaced the instruction file'
  [ ! -L "$user_home/.claude/CLAUDE.md" ] || fail 'dry-run created an instruction link'
  [ ! -e "$state_root" ] || fail 'dry-run created the state directory'
  grep -Fq 'BACKUP' "$output" || fail 'dry-run did not report backup action'
  grep -Fq 'LINK' "$output" || fail 'dry-run did not report link action'
}

test_skill_conflict_stops_preflight() {
  local case_root="$TEST_ROOT/conflict"
  local user_home="$case_root/home"
  local state_root="$case_root/state"

  mkdir -p "$user_home/.agents/skills/find-skills"
  cp -R "$REPO_ROOT/skills/mise-add/." "$user_home/.agents/skills/find-skills/"

  expect_status 1 run_bootstrap "$user_home" "$state_root" --dry-run
  [ ! -e "$user_home/.claude/CLAUDE.md" ] || fail 'conflict preflight made a change'
  [ ! -e "$state_root" ] || fail 'conflict preflight created a backup'
}

test_mid_install_failure_rolls_back() {
  local case_root="$TEST_ROOT/rollback"
  local user_home="$case_root/home"
  local state_root="$case_root/state"

  mkdir -p "$user_home/.claude"
  printf '%s\n' 'legacy instructions' > "$user_home/.claude/CLAUDE.md"
  printf '%s\n' 'blocks directory creation' > "$user_home/.codex"

  expect_status 1 run_bootstrap "$user_home" "$state_root"
  [ -f "$user_home/.claude/CLAUDE.md" ] || fail 'rollback did not restore the instruction file'
  [ ! -L "$user_home/.claude/CLAUDE.md" ] || fail 'rollback left a managed link'
  grep -Fq 'legacy instructions' "$user_home/.claude/CLAUDE.md" || fail 'rollback restored wrong content'
  [ -f "$user_home/.codex" ] || fail 'rollback changed the blocking path'
}

test_missing_skill_file_stops_preflight() {
  local case_root="$TEST_ROOT/malformed"
  local copied_repo="$case_root/repo"
  local user_home="$case_root/home"

  mkdir -p "$case_root"
  cp -R "$REPO_ROOT" "$copied_repo"
  mkdir -p "$copied_repo/skills/broken"
  mkdir -p "$user_home"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/state" "$copied_repo/bootstrap" --dry-run
  [ ! -e "$user_home/.claude/CLAUDE.md" ] || fail 'malformed skill preflight made a change'
}

test_paths_with_spaces() {
  local case_root="$TEST_ROOT/path with spaces"
  local copied_repo="$case_root/repo with spaces"
  local user_home="$case_root/home with spaces"
  local state_root="$case_root/state with spaces"
  local canonical_repo

  mkdir -p "$case_root"
  cp -R "$REPO_ROOT" "$copied_repo"
  canonical_repo="$(cd "$copied_repo" && pwd -P)"
  mkdir -p "$user_home"
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" >/dev/null
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" --check >/dev/null
  assert_link "$user_home/.codex/AGENTS.md" "$canonical_repo/AGENTS.md"
}

test_removed_skill_is_detected_and_cleaned() {
  local case_root="$TEST_ROOT/removed-skill"
  local copied_repo="$case_root/repo"
  local user_home="$case_root/home"
  local state_root="$case_root/state"

  mkdir -p "$case_root" "$user_home"
  cp -R "$REPO_ROOT" "$copied_repo"
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" >/dev/null
  mv "$copied_repo/skills/find-skills" "$case_root/removed-find-skills"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" --check
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" >/dev/null
  [ ! -L "$user_home/.claude/skills/find-skills" ] || fail 'removed Claude skill link remains'
  [ ! -L "$user_home/.agents/skills/find-skills" ] || fail 'removed shared skill link remains'
  [ ! -L "$user_home/.codex/skills/find-skills" ] || fail 'removed Codex skill link remains'
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" --check >/dev/null
}

test_broken_skill_link_is_repaired() {
  local case_root="$TEST_ROOT/broken-link"
  local user_home="$case_root/home"
  local state_root="$case_root/state"

  mkdir -p "$user_home/.agents/skills"
  ln -s "$case_root/old-clone/skills/find-skills" "$user_home/.agents/skills/find-skills"
  run_bootstrap "$user_home" "$state_root" >/dev/null
  assert_link "$user_home/.agents/skills/find-skills" "$REPO_ROOT/skills/find-skills"
}

test_source_symlink_is_rejected() {
  local case_root="$TEST_ROOT/source-symlink"
  local copied_repo="$case_root/repo"
  local user_home="$case_root/home"

  mkdir -p "$case_root" "$user_home"
  cp -R "$REPO_ROOT" "$copied_repo"
  ln -s /etc/passwd "$copied_repo/skills/mise-add/unsafe-reference"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/state" "$copied_repo/bootstrap" --dry-run
  [ ! -e "$user_home/.claude/CLAUDE.md" ] || fail 'source symlink preflight made a change'
}

test_source_root_symlinks_are_rejected() {
  local case_root="$TEST_ROOT/source-root-symlinks"
  local instruction_repo="$case_root/instruction-repo"
  local skills_repo="$case_root/skills-repo"
  local entry_repo="$case_root/entry-repo"
  local user_home="$case_root/home"

  mkdir -p "$case_root" "$user_home"

  cp -R "$REPO_ROOT" "$instruction_repo"
  mv "$instruction_repo/AGENTS.md" "$instruction_repo/AGENTS.real.md"
  ln -s AGENTS.real.md "$instruction_repo/AGENTS.md"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/instruction-state" "$instruction_repo/bootstrap" --dry-run

  cp -R "$REPO_ROOT" "$skills_repo"
  mv "$skills_repo/skills" "$skills_repo/skills.real"
  ln -s skills.real "$skills_repo/skills"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/skills-state" "$skills_repo/bootstrap" --dry-run

  cp -R "$REPO_ROOT" "$entry_repo"
  ln -s mise-add "$entry_repo/skills/linked-skill"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/entry-state" "$entry_repo/bootstrap" --dry-run
}

test_stale_cleanup_failure_rolls_back() {
  local case_root="$TEST_ROOT/stale-rollback"
  local copied_repo="$case_root/repo"
  local canonical_repo
  local user_home="$case_root/home"
  local state_root="$case_root/state"

  mkdir -p "$case_root" "$user_home"
  cp -R "$REPO_ROOT" "$copied_repo"
  canonical_repo="$(cd "$copied_repo" && pwd -P)"
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" >/dev/null
  cp "$state_root/managed-links.tsv" "$case_root/managed-links.before.tsv"
  mv "$copied_repo/skills/find-skills" "$case_root/removed-find-skills"
  rm "$user_home/.pi/agent/AGENTS.md"
  rm "$user_home/.pi/agent/extensions/ai-harness-prewalk.ts"
  rm "$user_home/.pi/agent/extensions/prewalk-core.mjs"
  rmdir "$user_home/.pi/agent/extensions"
  rmdir "$user_home/.pi/agent"
  rmdir "$user_home/.pi"
  printf '%s\n' 'blocks directory creation' > "$user_home/.pi"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap"
  assert_link "$user_home/.claude/skills/find-skills" "$canonical_repo/skills/find-skills"
  assert_link "$user_home/.agents/skills/find-skills" "$canonical_repo/skills/find-skills"
  cmp "$case_root/managed-links.before.tsv" "$state_root/managed-links.tsv" >/dev/null || fail 'failed stale cleanup changed the managed manifest'
}

test_cli_contract() {
  "$BOOTSTRAP" --help >/dev/null
  expect_status 2 "$BOOTSTRAP" --unknown
  expect_status 2 "$BOOTSTRAP" --dry-run --check
}

test_fresh_install_backup_and_idempotency
test_dry_run_has_no_side_effects
test_skill_conflict_stops_preflight
test_mid_install_failure_rolls_back
test_missing_skill_file_stops_preflight
test_paths_with_spaces
test_removed_skill_is_detected_and_cleaned
test_broken_skill_link_is_repaired
test_source_symlink_is_rejected
test_source_root_symlinks_are_rejected
test_stale_cleanup_failure_rolls_back
test_cli_contract

printf '%s\n' 'All bootstrap tests passed.'
