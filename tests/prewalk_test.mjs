import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import {
  createPrewalkState,
  isPlanPath,
  isScratchPath,
  parsePrewalkArgs,
  parsePrewalkConfig,
} from "../extensions/prewalk-core.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const testConfig = {
  firstModel: "provider-a/model-a",
  secondModel: "provider-b/model-b",
}

function testConfigAndArguments() {
  assert.deepEqual(parsePrewalkConfig({
    first_model: testConfig.firstModel,
    second_model: testConfig.secondModel,
  }), testConfig)
  assert.deepEqual(parsePrewalkArgs("", testConfig), testConfig)
  assert.deepEqual(parsePrewalkArgs("provider-c/model-c", testConfig), {
    firstModel: testConfig.firstModel,
    secondModel: "provider-c/model-c",
  })
  assert.deepEqual(parsePrewalkArgs("provider-c/model-c provider-d/model-d"), {
    firstModel: "provider-c/model-c",
    secondModel: "provider-d/model-d",
  })
  assert.throws(() => parsePrewalkArgs(""), /local Prewalk config/)
  assert.throws(() => parsePrewalkArgs("one two three", testConfig), /expects zero, one, or two model IDs/)
  assert.throws(() => parsePrewalkArgs("invalid", testConfig), /provider\/model/)
  assert.throws(() => parsePrewalkConfig({ first_model: "provider/model" }), /second_model/)
}

function testPlanPaths() {
  assert.equal(isPlanPath(".temp-local/workflow-plan.md"), true)
  assert.equal(isPlanPath("TODO.md"), false)
  assert.equal(isPlanPath("plans/refactor.plan.md"), false)
  assert.equal(isPlanPath("src/todo.ts"), false)
  assert.equal(isPlanPath(".temp-local/../src/workflow-plan.md"), false)
  assert.equal(isScratchPath(".temp-local/../src/app.ts"), false)
}

function testHandoffState() {
  const state = createPrewalkState()
  state.arm(testConfig)

  assert.match(state.observeToolCall("code-before-plan", "write", { path: "src/app.ts" }).reason, /plan file first/)
  assert.match(state.observeToolCall("shell", "bash", { command: "printf bad > src/app.ts" }).reason, /only read, grep, find, ls, edit, and write/)
  assert.equal(state.observeToolCall("scratch", "write", { path: ".temp-local/notes.md" }), undefined)
  assert.equal(state.observeToolCall("plan", "write", { path: ".temp-local/workflow-plan.md" }), undefined)
  assert.match(state.observeToolCall("code-before-plan-result", "edit", { path: "src/app.ts" }).reason, /plan file first/)
  state.observeToolResult("plan", false)
  assert.equal(state.observeToolCall("read", "read", { path: "src/app.ts" }), undefined)
  assert.equal(state.observeToolCall("code", "edit", { path: "src/app.ts" }), undefined)
  assert.equal(state.readyToHandoff(), false)
  assert.match(state.observeToolCall("second-code", "write", { path: "src/other.ts" }).reason, /one code mutation/)
  state.observeToolResult("code", false)
  assert.equal(state.readyToHandoff(), true)

  state.beginHandoff()
  state.completeHandoff(true)
  assert.equal(state.stage(), "worker")
  assert.equal(state.observeToolCall("worker-write", "write", { path: "src/other.ts" }), undefined)
  state.finish()
  assert.equal(state.stage(), "idle")
}

function testFailedWritesDoNotAdvanceState() {
  const state = createPrewalkState()
  state.arm(testConfig)

  state.observeToolCall("failed-plan", "write", { path: ".temp-local/workflow-plan.md" })
  state.observeToolResult("failed-plan", true)
  assert.match(state.observeToolCall("code", "edit", { path: "src/app.ts" }).reason, /plan file first/)

  state.observeToolCall("plan", "write", { path: ".temp-local/workflow-plan.md" })
  state.observeToolResult("plan", false)
  state.observeToolCall("failed-code", "edit", { path: "src/app.ts" })
  state.observeToolResult("failed-code", true)
  assert.equal(state.readyToHandoff(), false)
  assert.equal(state.observeToolCall("retry-code", "edit", { path: "src/app.ts" }), undefined)
}

function testLauncher() {
  const root = mkdtempSync(join(tmpdir(), "ai-harness-prewalk-test-"))
  const fakeBin = join(root, "bin")
  const output = join(root, "arguments.txt")
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, "pi"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${output}"\n`)
  chmodSync(join(fakeBin, "pi"), 0o755)

  try {
    execFileSync(join(repoRoot, "bin", "pi-prewalk"), ["--list-models"], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    })
    assert.deepEqual(readFileSync(output, "utf8").trim().split("\n"), ["--list-models"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

assert.equal(existsSync(join(repoRoot, "skills", "prewalk", "SKILL.md")), true)
assert.equal(existsSync(join(repoRoot, "skills", "harness-workflow", "SKILL.md")), true)
testConfigAndArguments()
testPlanPaths()
testHandoffState()
testFailedWritesDoNotAdvanceState()
testLauncher()

console.log("All prewalk tests passed.")
