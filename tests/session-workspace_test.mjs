import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { createSessionWorkspace } from "../skills/planning/scripts/session-workspace.mjs"

const helper = resolve(import.meta.dirname, "../skills/planning/scripts/session-workspace.mjs")
const moment = new Date(2026, 9, 26, 14, 30, 52)

function withProject(run) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "harness-session-test-")))
  return Promise.resolve().then(() => run(project)).finally(() => rmSync(project, { recursive: true, force: true }))
}

function runNode(args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, options)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolveResult({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

test("uses local time and a readable description without UUIDs", () => withProject((project) => {
  const directory = createSessionWorkspace(project, "plan-isolation", moment)
  assert.equal(basename(directory), "20261026-143052-plan-isolation")
  assert.equal(directory, join(project, ".temp-local/sessions/20261026-143052-plan-isolation"))
  assert.equal(existsSync(directory), true)
}))

test("collisions get numeric suffixes and preserve existing contents", () => withProject((project) => {
  const first = createSessionWorkspace(project, "plan-isolation", moment)
  const sentinel = join(first, "workflow-plan.md")
  writeFileSync(sentinel, "existing approved plan")
  const second = createSessionWorkspace(project, "plan-isolation", moment)
  const third = createSessionWorkspace(project, "plan-isolation", moment)
  assert.equal(second, `${first}-2`)
  assert.equal(third, `${first}-3`)
  assert.equal(readFileSync(sentinel, "utf8"), "existing approved plan")
}))

test("an existing file reserves its name without being overwritten", () => withProject((project) => {
  const root = join(project, ".temp-local", "sessions")
  mkdirSync(root, { recursive: true })
  const occupied = join(root, "20261026-143052-plan-isolation")
  writeFileSync(occupied, "preserve this file")
  assert.equal(createSessionWorkspace(project, "plan-isolation", moment), `${occupied}-2`)
  assert.equal(readFileSync(occupied, "utf8"), "preserve this file")
}))

test("rejects descriptions that cannot safely name a directory", () => withProject((project) => {
  for (const description of ["", "../escape", "nested/path", "two words", "-leading", "trailing-", "a".repeat(65)]) {
    assert.throws(() => createSessionWorkspace(project, description, moment), /description/)
  }
  assert.equal(existsSync(join(project, ".temp-local")), false)
}))

test("rejects a sessions root symlink that points outside the project", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "harness-session-boundary-")))
  const project = join(sandbox, "project")
  const outside = join(sandbox, "outside")
  mkdirSync(project)
  mkdirSync(outside)
  mkdirSync(join(project, ".temp-local"), { recursive: true })
  symlinkSync(outside, join(project, ".temp-local", "sessions"))
  try {
    assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), /symbolic link/)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test("rejects a sessions root symlink that stays inside the project", () => withProject((project) => {
  const internal = join(project, "workspace-data")
  mkdirSync(internal)
  mkdirSync(join(project, ".temp-local"))
  symlinkSync(internal, join(project, ".temp-local", "sessions"))
  assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), /symbolic link/)
  assert.deepEqual(readdirSync(internal), [])
}))

test("does not create sessions outside when .temp-local points outside", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "harness-temp-root-boundary-")))
  const project = join(sandbox, "project")
  const outside = join(sandbox, "outside")
  mkdirSync(project)
  mkdirSync(outside)
  symlinkSync(outside, join(project, ".temp-local"))
  try {
    assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), /symbolic link/)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test("rejects an internal .temp-local symlink to keep workspaces in the ignored directory", () => withProject((project) => {
  const internal = join(project, "local-data")
  mkdirSync(internal)
  symlinkSync(internal, join(project, ".temp-local"))
  assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), /symbolic link/)
  assert.deepEqual(readdirSync(internal), [])
}))

test("rejects .temp-local symlinks that resolve to the project itself", () => withProject((project) => {
  symlinkSync(project, join(project, ".temp-local"))
  assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), /symbolic link/)
  assert.equal(existsSync(join(project, "sessions")), false)
}))

test("rejects a non-directory temporary path without creating descendants", () => withProject((project) => {
  writeFileSync(join(project, ".temp-local"), "blocked")
  assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), /temporary directory must be a directory/)
  assert.equal(existsSync(join(project, ".temp-local", "sessions")), false)
}))

test("rejects invalid dates before creating directories", () => withProject((project) => {
  for (const invalid of [new Date(NaN), "2026-10-26", null]) {
    assert.throws(() => createSessionWorkspace(project, "plan-isolation", invalid), /timestamp/)
  }
  assert.equal(existsSync(join(project, ".temp-local")), false)
}))

test("returns permission errors from directory allocation without retrying", { skip: process.getuid?.() === 0 }, () => withProject((project) => {
  const root = join(project, ".temp-local", "sessions")
  mkdirSync(root, { recursive: true })
  chmodSync(root, 0o500)
  try {
    assert.throws(() => createSessionWorkspace(project, "plan-isolation", moment), { code: "EACCES" })
  } finally {
    chmodSync(root, 0o700)
  }
}))

test("independent processes atomically reserve different directories", () => withProject(async (project) => {
  const script = `import { createSessionWorkspace } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(createSessionWorkspace(process.argv[1], 'plan-isolation', new Date(2026, 9, 26, 14, 30, 52)))`
  const results = await Promise.all(Array.from({ length: 12 }, () => runNode(["--input-type=module", "-e", script, project])))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  const directories = results.map((result) => result.stdout)
  assert.equal(new Set(directories).size, results.length)
  assert.ok(directories.every((directory) => existsSync(directory)))
}))

test("CLI returns the allocated absolute directory and rejects bad arguments", () => withProject(async (project) => {
  const result = await runNode([helper, project, "plan-isolation"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(existsSync(result.stdout), true)
  assert.match(basename(result.stdout), /^\d{8}-\d{6}-plan-isolation$/)
  const invalid = await runNode([helper, project, "../escape"])
  assert.notEqual(invalid.code, 0)
  assert.match(invalid.stderr, /description/)
  const missing = await runNode([helper])
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /Usage/)
}))

test("CLI works through an installed skill symlink", () => withProject(async (project) => {
  const installed = join(project, "planning")
  symlinkSync(resolve(import.meta.dirname, "../skills/planning"), installed, "dir")
  const result = await runNode([join(installed, "scripts/session-workspace.mjs"), project, "plan-isolation"])
  assert.equal(result.code, 0, result.stderr)
  assert.notEqual(result.stdout, "")
  assert.equal(existsSync(result.stdout), true)
}))

test("importing the helper does not interpret the host program's arguments", async () => {
  const script = `import { createSessionWorkspace } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(typeof createSessionWorkspace)`
  const result = await runNode(["--input-type=module", "-e", script, "not-a-file"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, "function")
})
