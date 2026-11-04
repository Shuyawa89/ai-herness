import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"

const script = resolve(import.meta.dirname, "../skills/planning/scripts/show-workflow-plan.mjs")
const fakeHerdr = `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + "\\n")
const command = args.slice(0, 3).join(" ")
if (process.env.HERDR_TEST_TIMEOUT === command) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
}
if (process.env.HERDR_TEST_FAILURE === command) {
  process.stderr.write("mock command failure\\n")
  process.exit(7)
}
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ server: { running: process.env.HERDR_TEST_SERVER_RUNNING !== "0", compatible: true } }))
} else if (args[0] === "pane" && args[1] === "current") {
  process.stdout.write(JSON.stringify({ result: { pane: {
    pane_id: process.env.HERDR_TEST_CURRENT_PANE || "w4:p1",
    workspace_id: "w4",
    tab_id: "w4:t1",
    cwd: process.env.HERDR_TEST_PANE_CWD,
    foreground_cwd: process.env.HERDR_TEST_FOREGROUND_CWD || process.env.HERDR_TEST_PANE_CWD,
    focused: process.env.HERDR_TEST_FOCUSED !== "0"
  } } }))
} else if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ result: { plugins: [{
    plugin_id: "herdr-file-viewer",
    enabled: process.env.HERDR_TEST_PLUGIN_ENABLED !== "0",
    platforms: ["linux", "macos"]
  }] } }))
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  process.stdout.write("opened")
} else {
  process.stderr.write("unexpected mock command\\n")
  process.exit(9)
}
`

function createFixture({ git = true, projectName = "project with spaces; $(touch marker)", paneCwd } = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "show-workflow-plan-")))
  const project = join(temporary, projectName)
  const bin = join(temporary, "bin")
  const log = join(temporary, "herdr-args.jsonl")
  const workspace = join(project, ".temp-local", "sessions", "20261104-120000-test-workspace")
  const plan = join(workspace, "workflow-plan.md")
  mkdirSync(project, { recursive: true })
  mkdirSync(bin)
  if (git) {
    execFileSync("git", ["init", "--quiet", project])
    writeFileSync(join(project, ".gitignore"), ".temp-local/\n")
  }
  mkdirSync(workspace, { recursive: true })
  writeFileSync(plan, "# Approved plan\n")
  writeFileSync(join(bin, "herdr"), fakeHerdr)
  chmodSync(join(bin, "herdr"), 0o755)

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HERDR_ENV: "1",
    HERDR_BIN_PATH: undefined,
    HERDR_WORKFLOW_PLAN_VIEWER: undefined,
    HERDR_PANE_ID: "w4:p1",
    HERDR_WORKSPACE_ID: "w4",
    HERDR_TAB_ID: "w4:t1",
    HERDR_TEST_LOG: log,
    HERDR_TEST_PANE_CWD: paneCwd ?? project,
  }
  return { temporary, project, workspace, plan, bin, log, env }
}

function run(fixture, args = [], overrides = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.project,
    env: { ...fixture.env, ...overrides },
    encoding: "utf8",
    timeout: 12000,
    maxBuffer: 1024 * 1024,
  })
}

function runAsync(fixture, args = [], overrides = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: fixture.project,
      env: { ...fixture.env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolveResult({ code, stdout, stderr }))
  })
}

function calls(fixture) {
  if (!existsSync(fixture.log)) return []
  return readFileSync(fixture.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function opens(fixture) {
  return calls(fixture).filter((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open")
}

function cleanup(fixture) {
  rmSync(fixture.temporary, { recursive: true, force: true })
}

test("opens only the absolute ignored plan as one shell-free env argument in a non-focused split", () => {
  const fixture = createFixture()
  try {
    assert.equal(spawnSync("git", ["-C", fixture.project, "check-ignore", "-q", fixture.plan]).status, 0)
    const result = run(fixture, [fixture.plan])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.deepEqual(opens(fixture), [[
      "plugin", "pane", "open",
      "--plugin", "herdr-file-viewer",
      "--entrypoint", "file-viewer",
      "--placement", "split",
      "--target-pane", "w4:p1",
      "--direction", "right",
      "--no-focus",
      "--env", `HERDR_FILE_VIEWER_OPEN=${fixture.plan}`,
    ]])
    assert.equal(existsSync(join(fixture.project, "marker")), false)
    assert.equal(calls(fixture).some((args) => args[1] === "focus" || args.includes("--cwd")), false)
  } finally {
    cleanup(fixture)
  }
})

test("accepts a plan at the Git top level when the pane cwd is nested in that repository", () => {
  const fixture = createFixture()
  try {
    const nested = join(fixture.project, "packages", "tool")
    mkdirSync(nested, { recursive: true })
    const result = run(fixture, [fixture.plan], { HERDR_TEST_PANE_CWD: nested })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opens(fixture).length, 1)
  } finally {
    cleanup(fixture)
  }
})

test("opens a session workspace in a project nested under the viewer's Git root", () => {
  const fixture = createFixture()
  try {
    const nestedProject = join(fixture.project, "packages", "nested")
    const nestedWorkspace = join(nestedProject, ".temp-local", "sessions", "20261104-120001-nested")
    const nestedPlan = join(nestedWorkspace, "workflow-plan.md")
    mkdirSync(nestedWorkspace, { recursive: true })
    writeFileSync(nestedPlan, "# Nested plan\n")
    const result = run(fixture, [nestedPlan], { HERDR_TEST_PANE_CWD: nestedProject })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opens(fixture).length, 1)
    assert.ok(opens(fixture)[0].includes(`HERDR_FILE_VIEWER_OPEN=${nestedPlan}`))
  } finally {
    cleanup(fixture)
  }
})

test("uses the pane cwd as the viewer root outside a Git repository", () => {
  const fixture = createFixture({ git: false })
  try {
    const result = run(fixture, [fixture.plan])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opens(fixture).length, 1)
  } finally {
    cleanup(fixture)
  }
})

test("uses the pane cwd when Git is unavailable", () => {
  const fixture = createFixture({ git: false })
  try {
    const result = run(fixture, [fixture.plan], {
      PATH: `${fixture.bin}:${dirname(process.execPath)}`,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opens(fixture).length, 1)
  } finally {
    cleanup(fixture)
  }
})

test("does not open a plan when the caller's pane is not the current focused pane", () => {
  const fixture = createFixture()
  try {
    for (const overrides of [
      { HERDR_TEST_CURRENT_PANE: "w9:p1" },
      { HERDR_TEST_FOCUSED: "0" },
      { HERDR_WORKSPACE_ID: "w9" },
      { HERDR_TAB_ID: "w9:t1" },
    ]) {
      const result = run(fixture, [fixture.plan], overrides)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "")
      assert.equal(opens(fixture).length, 0)
    }
  } finally {
    cleanup(fixture)
  }
})

test("does not open a plan from a different Git root", () => {
  const fixture = createFixture()
  const other = join(fixture.temporary, "other-repository")
  try {
    mkdirSync(other)
    execFileSync("git", ["init", "--quiet", other])
    const result = run(fixture, [fixture.plan], { HERDR_TEST_PANE_CWD: other })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opens(fixture).length, 0)
  } finally {
    cleanup(fixture)
  }
})

test("fails closed when Git root resolution fails unexpectedly", () => {
  const fixture = createFixture()
  try {
    const mockGit = join(fixture.bin, "git")
    writeFileSync(mockGit, "#!/usr/bin/env node\nprocess.stderr.write('fatal: bad repository config\\n'); process.exit(128)\n")
    chmodSync(mockGit, 0o755)
    const probe = spawnSync(mockGit, [], { encoding: "utf8" })
    assert.equal(probe.status, 128)
    assert.match(probe.stderr, /fatal: bad repository config/)

    const result = run(fixture, ["--diagnose", fixture.plan])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /Git root check failed/)
    assert.equal(result.stderr, "")
    assert.equal(opens(fixture).length, 0)
  } finally {
    cleanup(fixture)
  }
})

test("rejects paths outside the exact workspace plan location and symlinked plan files", () => {
  const fixture = createFixture()
  const outside = join(fixture.temporary, "outside.md")
  try {
    writeFileSync(outside, "outside\n")
    const invalidPaths = [
      "relative/workflow-plan.md",
      join(fixture.project, "README.md"),
      join(fixture.workspace, "notes.md"),
      join(fixture.project, ".temp-local", "sessions", "nested", "extra", "workflow-plan.md"),
      join(fixture.workspace, "missing.md"),
    ]
    for (const target of invalidPaths) {
      const result = run(fixture, [target])
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "")
    }
    rmSync(fixture.plan)
    symlinkSync(outside, fixture.plan)
    const symlinkResult = run(fixture, [fixture.plan])
    assert.equal(symlinkResult.status, 0, symlinkResult.stderr)
    assert.equal(opens(fixture).length, 0)
  } finally {
    cleanup(fixture)
  }
})

test("uses HERDR_BIN_PATH when the server supplies an explicit executable", () => {
  const fixture = createFixture()
  try {
    const explicit = join(fixture.bin, "custom-herdr")
    writeFileSync(explicit, fakeHerdr)
    chmodSync(explicit, 0o755)
    const result = run(fixture, [fixture.plan], { HERDR_BIN_PATH: explicit })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opens(fixture).length, 1)
    const original = join(fixture.bin, "herdr")
    rmSync(original)
    assert.equal(run(fixture, ["--retry", fixture.plan], { HERDR_BIN_PATH: explicit }).status, 0)
    assert.equal(opens(fixture).length, 2)
  } finally {
    cleanup(fixture)
  }
})

test("quietly skips when HERDR_ENV or the caller pane ID is missing", () => {
  const fixture = createFixture()
  try {
    for (const overrides of [
      { HERDR_ENV: undefined },
      { HERDR_PANE_ID: undefined },
    ]) {
      const result = run(fixture, [fixture.plan], overrides)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "")
      assert.deepEqual(calls(fixture), [])
    }
  } finally {
    cleanup(fixture)
  }
})

test("supports an environment opt-out without contacting Herdr", () => {
  const fixture = createFixture()
  try {
    const result = run(fixture, [fixture.plan], { HERDR_WORKFLOW_PLAN_VIEWER: "off" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.deepEqual(calls(fixture), [])
  } finally {
    cleanup(fixture)
  }
})

test("quietly skips when the server is unavailable or the plugin is disabled", () => {
  const fixture = createFixture()
  try {
    for (const overrides of [
      { HERDR_TEST_SERVER_RUNNING: "0" },
      { HERDR_TEST_PLUGIN_ENABLED: "0" },
    ]) {
      const result = run(fixture, [fixture.plan], overrides)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "")
      assert.equal(opens(fixture).length, 0)
    }
  } finally {
    cleanup(fixture)
  }
})

test("diagnostics explain why an invocation was skipped without opening a pane", () => {
  const fixture = createFixture()
  try {
    const result = run(fixture, ["--diagnose", fixture.plan], { HERDR_TEST_PLUGIN_ENABLED: "0" })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /disabled/i)
    assert.equal(opens(fixture).length, 0)
    assert.equal(existsSync(join(fixture.workspace, ".workflow-plan-viewer-opened")), false)
  } finally {
    cleanup(fixture)
  }
})

test("survives Herdr CLI errors and timeout quietly", () => {
  const fixture = createFixture()
  try {
    const statusTimeout = run(fixture, [fixture.plan], { HERDR_TEST_TIMEOUT: "status --json" })
    assert.equal(statusTimeout.status, 0, statusTimeout.stderr)
    assert.equal(statusTimeout.stdout, "")
    assert.equal(statusTimeout.stderr, "")
    assert.equal(opens(fixture).length, 0)

    const failed = run(fixture, [fixture.plan], { HERDR_TEST_FAILURE: "plugin pane open" })
    assert.equal(failed.status, 0, failed.stderr)
    assert.equal(failed.stdout, "")
    assert.equal(failed.stderr, "")
    assert.equal(opens(fixture).length, 1)

    const timedOut = run(fixture, ["--retry", fixture.plan], { HERDR_TEST_TIMEOUT: "plugin pane open" })
    assert.equal(timedOut.status, 0, timedOut.stderr)
    assert.equal(timedOut.stdout, "")
    assert.equal(timedOut.stderr, "")
    assert.equal(opens(fixture).length, 2)
  } finally {
    cleanup(fixture)
  }
})

test("prevents duplicate launches per workspace and allows an explicit retry", () => {
  const fixture = createFixture()
  try {
    assert.equal(run(fixture, [fixture.plan]).status, 0)
    const diagnostic = run(fixture, ["--diagnose", fixture.plan])
    assert.equal(diagnostic.status, 1)
    assert.match(diagnostic.stdout, /viewer launch was already attempted/)
    assert.match(diagnostic.stdout, /--retry may create another split/)
    assert.equal(opens(fixture).length, 1)
    assert.equal(run(fixture, [fixture.plan]).status, 0)
    assert.equal(opens(fixture).length, 1)
    assert.equal(run(fixture, ["--retry", fixture.plan]).status, 0)
    assert.equal(opens(fixture).length, 2)
  } finally {
    cleanup(fixture)
  }
})

test("concurrent invocations create only one viewer pane", async () => {
  const fixture = createFixture()
  try {
    const results = await Promise.all([
      runAsync(fixture, [fixture.plan]),
      runAsync(fixture, [fixture.plan]),
    ])
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "")
    }
    assert.equal(opens(fixture).length, 1)
  } finally {
    cleanup(fixture)
  }
})

test("handles CLI usage errors quietly unless diagnostics were explicitly requested", () => {
  const fixture = createFixture()
  try {
    const quiet = run(fixture)
    assert.equal(quiet.status, 0)
    assert.equal(quiet.stdout, "")
    assert.equal(quiet.stderr, "")
    const help = run(fixture, ["--help"])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /timed-out launch may still have succeeded/)
    assert.match(help.stdout, /HERDR_WORKFLOW_PLAN_VIEWER=off/)
    const diagnostic = run(fixture, ["--diagnose"])
    assert.notEqual(diagnostic.status, 0)
    assert.match(diagnostic.stdout + diagnostic.stderr, /Usage:/)
  } finally {
    cleanup(fixture)
  }
})
