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
  local bootstrap="$1"
  local user_home="$2"
  local state_root="$3"
  shift 3
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$bootstrap" "$@"
}

test_fresh_install_backup_and_idempotency() {
  local case_root="$TEST_ROOT/fresh"
  local copied_repo="$case_root/repo"
  local user_home="$case_root/home"
  local state_root="$case_root/state"
  local canonical_repo
  local canonical_home
  local backup_count_before
  local backup_count_after

  mkdir -p "$case_root" "$user_home/.claude/skills"
  cp -R "$REPO_ROOT" "$copied_repo"
  rm -f "$copied_repo/prewalk.json"
  canonical_repo="$(cd "$copied_repo" && pwd -P)"
  canonical_home="$(cd "$user_home" && pwd -P)"
  printf '%s\n' 'legacy instructions' > "$user_home/.claude/CLAUDE.md"
  cp -R "$REPO_ROOT/skills/explore" "$user_home/.claude/skills/explore"

  run_bootstrap "$copied_repo/bootstrap" "$user_home" "$state_root" > "$case_root/install-output.txt"
  grep -Fq 'Note: prewalk.json not found' "$case_root/install-output.txt" || fail 'missing prewalk config reminder'
  run_bootstrap "$copied_repo/bootstrap" "$user_home" "$state_root" --check >/dev/null

  assert_link "$user_home/.claude/CLAUDE.md" "$canonical_repo/AGENTS.md"
  assert_link "$user_home/.codex/AGENTS.md" "$canonical_repo/AGENTS.md"
  assert_link "$user_home/.pi/agent/AGENTS.md" "$canonical_repo/AGENTS.md"
  assert_link "$user_home/.pi/agent/extensions/ai-harness-prewalk.ts" "$canonical_repo/extensions/pi-prewalk.ts"
  assert_link "$user_home/.pi/agent/extensions/prewalk-core.mjs" "$canonical_repo/extensions/prewalk-core.mjs"
  assert_link "$user_home/.claude/skills/explore" "$canonical_repo/skills/explore"
  assert_link "$user_home/.codex/skills/explore" "$canonical_repo/skills/explore"
  assert_link "$user_home/.claude/skills/understand" "$canonical_repo/skill-variants/explicit/understand"
  assert_link "$user_home/.codex/skills/understand" "$canonical_repo/skills/understand"
  assert_link "$user_home/.agents/skills/understand" "$canonical_repo/skill-variants/explicit/understand"
  assert_link "$user_home/.claude/skills/design-check" "$canonical_repo/skill-variants/explicit/design-check"
  assert_link "$user_home/.codex/skills/design-check" "$canonical_repo/skills/design-check"
  assert_link "$user_home/.agents/skills/design-check" "$canonical_repo/skill-variants/explicit/design-check"
  grep -Fq "$canonical_home/.claude/CLAUDE.md" "$state_root"/backups/*/manifest.tsv || fail 'missing instruction backup manifest entry'

  [ ! -e "$user_home/.claude/skills/find-skills" ] || fail 'non-allowlisted skill was installed'
  [ ! -e "$user_home/.codex/skills/tdd-workflow" ] || fail 'non-allowlisted skill was installed'

  printf '{ "first_model": "provider-a/model-a", "second_model": "provider-b/model-b" }\n' > "$copied_repo/prewalk.json"
  run_bootstrap "$copied_repo/bootstrap" "$user_home" "$state_root" > "$case_root/second-output.txt"
  grep -Fq 'prewalk.json not found' "$case_root/second-output.txt" && fail 'reminder shown although prewalk config exists'

  backup_count_before="$(find "$state_root/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  run_bootstrap "$copied_repo/bootstrap" "$user_home" "$state_root" >/dev/null
  backup_count_after="$(find "$state_root/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  [ "$backup_count_before" = "$backup_count_after" ] || fail 'idempotent run created another backup'
}

test_explicit_skill_variants_match_sources() {
  local skill_name
  local source_file
  local variant_file
  local invocation_flag_count
  local frontmatter_invocation_flag_count
  local openai_config
  local implicit_invocation_policy_count

  for skill_name in understand design-check; do
    source_file="$REPO_ROOT/skills/$skill_name/SKILL.md"
    variant_file="$REPO_ROOT/skill-variants/explicit/$skill_name/SKILL.md"
    openai_config="$REPO_ROOT/skills/$skill_name/agents/openai.yaml"

    [ -f "$variant_file" ] || fail "missing explicit skill variant: $variant_file"
    invocation_flag_count="$(awk '$0 == "disable-model-invocation: true" { count++ } END { print count + 0 }' "$variant_file")"
    [ "$invocation_flag_count" -eq 1 ] || fail "expected exactly one disable-model-invocation flag: $variant_file"
    frontmatter_invocation_flag_count="$(awk '
      NR == 1 {
        if ($0 != "---") exit 2
        in_frontmatter = 1
        next
      }
      in_frontmatter && $0 == "---" {
        found_end = 1
        exit
      }
      in_frontmatter && $0 == "disable-model-invocation: true" { count++ }
      END {
        if (!found_end) exit 3
        print count + 0
      }
    ' "$variant_file")" || fail "invalid YAML frontmatter: $variant_file"
    [ "$frontmatter_invocation_flag_count" -eq 1 ] || fail "disable-model-invocation flag must be in the first YAML frontmatter: $variant_file"
    awk '$0 != "disable-model-invocation: true"' "$variant_file" | cmp "$source_file" - >/dev/null || fail "explicit skill variant differs from source: $skill_name"

    [ -f "$openai_config" ] || fail "missing OpenAI skill config: $openai_config"
    implicit_invocation_policy_count="$(awk '
      $0 == "policy:" {
        in_policy = 1
        next
      }
      in_policy && /^[^[:space:]]/ { in_policy = 0 }
      in_policy && $0 == "  allow_implicit_invocation: false" { count++ }
      END { print count + 0 }
    ' "$openai_config")"
    [ "$implicit_invocation_policy_count" -eq 1 ] || fail "OpenAI skill config must disable implicit invocation: $openai_config"
  done
}

test_dry_run_has_no_side_effects() {
  local case_root="$TEST_ROOT/dry-run"
  local user_home="$case_root/home"
  local state_root="$case_root/state"
  local output="$case_root/output.txt"

  mkdir -p "$user_home/.claude"
  printf '%s\n' 'legacy instructions' > "$user_home/.claude/CLAUDE.md"
  run_bootstrap "$BOOTSTRAP" "$user_home" "$state_root" --dry-run > "$output"

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

  mkdir -p "$user_home/.agents/skills/explore"
  cp -R "$REPO_ROOT/skills/worker/." "$user_home/.agents/skills/explore/"

  expect_status 1 run_bootstrap "$BOOTSTRAP" "$user_home" "$state_root" --dry-run
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

  expect_status 1 run_bootstrap "$BOOTSTRAP" "$user_home" "$state_root"
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
  rm "$copied_repo/skills/explore/SKILL.md"
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
  sed -i '' '/^  explore$/d' "$copied_repo/bootstrap"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" --check
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" >/dev/null
  [ ! -L "$user_home/.claude/skills/explore" ] || fail 'removed Claude skill link remains'
  [ ! -L "$user_home/.agents/skills/explore" ] || fail 'removed shared skill link remains'
  [ ! -L "$user_home/.codex/skills/explore" ] || fail 'removed Codex skill link remains'
  env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap" --check >/dev/null
}

test_missing_allowlisted_skill_fails_preflight() {
  local case_root="$TEST_ROOT/missing-allowlisted"
  local copied_repo="$case_root/repo"
  local user_home="$case_root/home"

  mkdir -p "$case_root" "$user_home"
  cp -R "$REPO_ROOT" "$copied_repo"
  mv "$copied_repo/skills/explore" "$case_root/removed-explore"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/state" "$copied_repo/bootstrap" --dry-run
}

test_broken_skill_link_is_repaired() {
  local case_root="$TEST_ROOT/broken-link"
  local user_home="$case_root/home"
  local state_root="$case_root/state"

  mkdir -p "$user_home/.agents/skills"
  ln -s "$case_root/old-clone/skills/explore" "$user_home/.agents/skills/explore"
  run_bootstrap "$BOOTSTRAP" "$user_home" "$state_root" >/dev/null
  assert_link "$user_home/.agents/skills/explore" "$REPO_ROOT/skills/explore"
}

test_source_symlink_is_rejected() {
  local case_root="$TEST_ROOT/source-symlink"
  local copied_repo="$case_root/repo"
  local user_home="$case_root/home"

  mkdir -p "$case_root" "$user_home"
  cp -R "$REPO_ROOT" "$copied_repo"
  ln -s /etc/passwd "$copied_repo/skills/explore/unsafe-reference"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/state" "$copied_repo/bootstrap" --dry-run
  [ ! -e "$user_home/.claude/CLAUDE.md" ] || fail 'source symlink preflight made a change'
}

test_source_root_symlinks_are_rejected() {
  local case_root="$TEST_ROOT/source-root-symlinks"
  local instruction_repo="$case_root/instruction-repo"
  local skills_repo="$case_root/skills-repo"
  local entry_repo="$case_root/entry-repo"
  local variant_parent_repo="$case_root/variant-parent-repo"
  local external_variant_parent="$case_root/external-skill-variants"
  local variant_root_repo="$case_root/variant-root-repo"
  local variant_entry_repo="$case_root/variant-entry-repo"
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
  ln -s planning "$entry_repo/skills/explore"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/entry-state" "$entry_repo/bootstrap" --dry-run

  cp -R "$REPO_ROOT" "$variant_parent_repo"
  mv "$variant_parent_repo/skill-variants" "$external_variant_parent"
  ln -s "$external_variant_parent" "$variant_parent_repo/skill-variants"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/variant-parent-state" "$variant_parent_repo/bootstrap" --dry-run

  cp -R "$REPO_ROOT" "$variant_root_repo"
  mv "$variant_root_repo/skill-variants/explicit" "$variant_root_repo/skill-variants/explicit.real"
  ln -s explicit.real "$variant_root_repo/skill-variants/explicit"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/variant-root-state" "$variant_root_repo/bootstrap" --dry-run

  cp -R "$REPO_ROOT" "$variant_entry_repo"
  mv "$variant_entry_repo/skill-variants/explicit/understand" "$variant_entry_repo/skill-variants/explicit/understand.real"
  ln -s design-check "$variant_entry_repo/skill-variants/explicit/understand"
  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$case_root/variant-entry-state" "$variant_entry_repo/bootstrap" --dry-run
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
  mv "$copied_repo/skills/explore" "$case_root/removed-explore"
  rm "$user_home/.pi/agent/AGENTS.md"
  rm "$user_home/.pi/agent/extensions/ai-harness-prewalk.ts"
  rm "$user_home/.pi/agent/extensions/prewalk-core.mjs"
  rmdir "$user_home/.pi/agent/extensions"
  rmdir "$user_home/.pi/agent"
  rmdir "$user_home/.pi"
  printf '%s\n' 'blocks directory creation' > "$user_home/.pi"

  expect_status 1 env AI_HARNESS_USER_HOME="$user_home" AI_HARNESS_STATE_ROOT="$state_root" "$copied_repo/bootstrap"
  assert_link "$user_home/.claude/skills/explore" "$canonical_repo/skills/explore"
  assert_link "$user_home/.agents/skills/explore" "$canonical_repo/skills/explore"
  cmp "$case_root/managed-links.before.tsv" "$state_root/managed-links.tsv" >/dev/null || fail 'failed stale cleanup changed the managed manifest'
}

test_cli_contract() {
  "$BOOTSTRAP" --help >/dev/null
  expect_status 2 "$BOOTSTRAP" --unknown
  expect_status 2 "$BOOTSTRAP" --dry-run --check
}

test_explicit_skill_variants_match_sources
test_fresh_install_backup_and_idempotency
test_dry_run_has_no_side_effects
test_skill_conflict_stops_preflight
test_mid_install_failure_rolls_back
test_missing_skill_file_stops_preflight
test_paths_with_spaces
test_removed_skill_is_detected_and_cleaned
test_missing_allowlisted_skill_fails_preflight
test_broken_skill_link_is_repaired
test_source_symlink_is_rejected
test_source_root_symlinks_are_rejected
test_stale_cleanup_failure_rolls_back
test_cli_contract

printf '%s\n' 'All bootstrap tests passed.'
