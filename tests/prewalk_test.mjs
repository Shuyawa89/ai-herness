import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

function withWorkspace(run) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "prewalk-core-")))
  const workspace = join(project, ".temp-local/sessions/20261026-120000-plan-isolation")
  mkdirSync(workspace, { recursive: true })
  try { run(project, workspace) } finally { rmSync(project, { recursive: true, force: true }) }
}

function testPlanPaths() {
  withWorkspace((project, workspace) => {
    assert.equal(isPlanPath(join(workspace, "workflow-plan.md"), workspace, project), true)
    assert.equal(isPlanPath(".temp-local/workflow-plan.md", workspace, project), false)
    assert.equal(isPlanPath("src/workflow-plan.md", workspace, project), false)
    assert.equal(isScratchPath(".temp-local/../src/app.ts", project), false)
    assert.equal(isScratchPath(join(workspace, "notes.md"), project), true)
  })
}

function testHandoffState() {
  withWorkspace((project, workspace) => {
    const state = createPrewalkState({ projectDirectory: project })
    state.arm(testConfig)
    assert.match(state.observeToolCall("unbound", "write", { path: "src/app.ts" }).reason, /workspace/)
    assert.equal(state.observeToolCall("allocate", "prewalk_workspace", { description: "plan-isolation" }), undefined)
    state.bindWorkspace(workspace)
    assert.match(state.observeToolCall("code-before-plan", "write", { path: "src/app.ts" }).reason, /plan file first/)
    assert.match(state.observeToolCall("shell", "bash", { command: "printf bad > src/app.ts" }).reason, /permits only/)
    assert.equal(state.observeToolCall("scratch", "write", { path: join(workspace, "notes.md") }), undefined)
    assert.equal(state.observeToolCall("plan", "write", { path: join(workspace, "workflow-plan.md") }), undefined)
    assert.match(state.observeToolCall("pending-plan", "edit", { path: "src/app.ts" }).reason, /plan file first/)
    state.observeToolResult("plan", false)
    assert.equal(state.observeToolCall("code", "edit", { path: "src/app.ts" }), undefined)
    assert.equal(state.readyToHandoff(), false)
    assert.match(state.observeToolCall("second", "write", { path: "src/other.ts" }).reason, /one code mutation/)
    state.observeToolResult("code", false)
    assert.equal(state.readyToHandoff(), true)
    assert.equal(state.beginHandoff(), true)
    state.completeHandoff(true)
    assert.equal(state.stage(), "worker")
    assert.equal(state.observeToolCall("worker-write", "write", { path: "src/other.ts" }), undefined)
    state.finish()
    state.arm(testConfig)
    assert.equal(state.workspace(), workspace)
    assert.match(state.observeToolCall("rearmed", "write", { path: "src/app.ts" }).reason, /plan file first/)
  })
}

function testFailedWritesDoNotAdvanceState() {
  withWorkspace((project, workspace) => {
    const state = createPrewalkState({ projectDirectory: project })
    state.bindWorkspace(workspace)
    state.arm(testConfig)
    state.observeToolCall("failed-plan", "write", { path: join(workspace, "workflow-plan.md") })
    state.observeToolResult("failed-plan", true)
    assert.match(state.observeToolCall("code", "edit", { path: "src/app.ts" }).reason, /plan file first/)
    state.observeToolCall("plan", "write", { path: join(workspace, "workflow-plan.md") })
    state.observeToolResult("plan", false)
    state.observeToolCall("failed-code", "edit", { path: "src/app.ts" })
    state.observeToolResult("failed-code", true)
    assert.equal(state.readyToHandoff(), false)
    assert.equal(state.observeToolCall("retry-code", "edit", { path: "src/app.ts" }), undefined)
  })
}

function testSessionIsolationAndPaths() {
  withWorkspace((project, workspace) => {
    const other = join(project, ".temp-local/sessions/20261026-120000-other-session")
    mkdirSync(other)
    const first = createPrewalkState({ projectDirectory: project })
    const second = createPrewalkState({ projectDirectory: project })
    first.bindWorkspace(workspace)
    second.bindWorkspace(other)
    first.arm(testConfig)
    second.arm(testConfig)
    const ownRelative = workspace.slice(project.length + 1)
    for (const target of [
      join(other, "workflow-plan.md"),
      `${ownRelative}/../20261026-120000-other-session/workflow-plan.md`,
      ".temp-local/workflow-plan.md",
    ]) {
      assert.equal(first.observeToolCall("foreign", "write", { path: target }).block, true)
      first.observeToolResult("foreign", false)
      assert.match(first.observeToolCall("code", "write", { path: "src/app.ts" }).reason, /plan file first/)
    }
    symlinkSync(other, join(workspace, "foreign"))
    assert.equal(first.observeToolCall("escape", "write", { path: join(workspace, "foreign/notes.md") }).block, true)
    symlinkSync(join(other, "missing-notes.md"), join(workspace, "dangling-notes.md"))
    assert.equal(first.observeToolCall("dangling", "write", { path: join(workspace, "dangling-notes.md") }).block, true)
    mkdirSync(join(project, "src"))
    symlinkSync(join(project, "src/missing.ts"), join(workspace, "dangling-source.ts"))
    assert.equal(first.observeToolCall("dangling-source", "write", { path: join(workspace, "dangling-source.ts") }).block, true)
    symlinkSync("loop", join(workspace, "loop"))
    assert.equal(first.observeToolCall("loop", "write", { path: join(workspace, "loop") }).block, true)
    symlinkSync(other, join(project, "other-alias"))
    assert.equal(first.observeToolCall("alias", "write", { path: "other-alias/notes.md" }).block, true)
    assert.equal(first.observeToolCall("own-plan", "write", { path: `${ownRelative}/./workflow-plan.md` }), undefined)
    first.observeToolResult("own-plan", false)
    assert.equal(first.observeToolCall("own-code", "write", { path: "src/app.ts" }), undefined)
    assert.match(second.observeToolCall("other-code", "write", { path: "src/app.ts" }).reason, /plan file first/)
  })
}

function testSymlinkedScratchRoot() {
  withWorkspace((project, workspace) => {
    const external = join(project, "external-sessions")
    mkdirSync(external)
    const own = join(external, "own-session")
    const other = join(external, "other-session")
    mkdirSync(own)
    mkdirSync(other)
    rmSync(join(project, ".temp-local/sessions"), { recursive: true })
    symlinkSync(external, join(project, ".temp-local/sessions"))
    const state = createPrewalkState({ projectDirectory: project })
    state.bindWorkspace(own)
    state.arm(testConfig)
    assert.equal(state.observeToolCall("own-plan", "write", { path: join(own, "workflow-plan.md") }), undefined)
    state.observeToolResult("own-plan", false)
    assert.equal(state.observeToolCall("foreign-notes", "write", { path: join(other, "notes.md") }).block, true)
  })
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
testSessionIsolationAndPaths()
testSymlinkedScratchRoot()
testLauncher()

console.log("All prewalk tests passed.")
