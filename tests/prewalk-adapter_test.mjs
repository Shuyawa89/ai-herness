import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(import.meta.dirname, "..")
const adapterFile = join(root, "extensions/pi-prewalk.ts")
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "prewalk-adapter-")))

// Run the actual adapter body without requiring Pi to be installed in the harness.
async function loadAdapter(extensionFile = adapterFile) {
  const source = readFileSync(extensionFile, "utf8")
    .replace('import { Type } from "@earendil-works/pi-ai"', 'const Type = { Object: (properties) => ({ type: "object", properties }), String: (options) => ({ type: "string", ...options }) }')
    .replace('from "./prewalk-core.mjs"', `from ${JSON.stringify(pathToFileURL(join(root, "extensions/prewalk-core.mjs")).href)}`)
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(extensionFile).href))
  const javascript = stripTypeScriptTypes(source, { mode: "strip" })
  return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)).default
}

function mockPi(adapter, projectDirectory, sessionId = "session-one", persistedEntries = []) {
  const handlers = new Map()
  const commands = new Map()
  const registeredTools = new Map()
  const entries = [...persistedEntries]
  const notifications = []
  const messages = []
  const models = []
  const ctx = {
    cwd: projectDirectory,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  }
  adapter({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => registeredTools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    setModel: async (model) => { models.push(model); handlers.get("model_select")?.({ model }, ctx); return true },
    sendMessage: (message, options) => messages.push({ message, options }),
  })
  return {
    entries, registeredTools, notifications, messages, models,
    event: (name, event = {}) => handlers.get(name)?.(event, ctx),
    command: (args) => commands.get("prewalk").handler(args, ctx),
    allocate: (description = "plan-isolation") => registeredTools.get("prewalk_workspace").execute("allocate", { description }, undefined, undefined, ctx),
    prompt: () => handlers.get("before_agent_start")({ systemPrompt: "Original system prompt" }, ctx)?.systemPrompt,
    switchSession: (id, records = entries) => { sessionId = id; const copy = [...records]; entries.splice(0, entries.length, ...copy) },
    call: (toolCallId, path, toolName = "write") => handlers.get("tool_call")({ toolCallId, toolName, input: { path } }, ctx),
    result: (toolCallId, isError = false) => handlers.get("tool_result")({ toolCallId, isError }, ctx),
  }
}

async function testLifecycle(adapter) {
  const project = join(temporary, "project")
  mkdirSync(project)
  const pi = mockPi(adapter, project)
  await pi.event("session_start", { reason: "startup" })
  await pi.command("provider-a/model-a provider-b/model-b")
  assert.match(pi.prompt(), /First call prewalk_workspace/)
  assert.match(pi.prompt(), /headings, explanatory prose, and diagram labels use Japanese/)
  assert.equal(pi.call("early-code", "src/app.ts").block, true)
  const tool = pi.registeredTools.get("prewalk_workspace")
  assert.equal(tool.executionMode, "sequential")
  assert.equal(tool.parameters.properties.description.maxLength, 64)
  const { details } = await pi.allocate()
  assert.match(details.workspaceDir, /\d{8}-\d{6}-plan-isolation$/)
  assert.equal(details.planPath, join(details.workspaceDir, "workflow-plan.md"))
  assert.deepEqual((await pi.allocate("another-description")).details, details)
  assert.equal(pi.entries.length, 1)
  assert.equal(pi.entries[0].data.sessionId, "session-one")
  assert.ok(pi.prompt().includes(details.workspaceDir))
  assert.ok(pi.prompt().includes(details.planPath))
  assert.equal(pi.call("foreign-plan", ".temp-local/sessions/another/workflow-plan.md").block, true)
  pi.result("foreign-plan")
  assert.equal(pi.call("code", "src/app.ts").block, true)
  assert.equal(pi.call("failed-plan", details.planPath), undefined)
  pi.result("failed-plan", true)
  assert.equal(pi.call("blocked-code", "src/app.ts").block, true)
  assert.equal(pi.call("own-plan", details.planPath), undefined)
  pi.result("own-plan")
  assert.equal(pi.call("failed-code", "src/app.ts"), undefined)
  pi.result("failed-code", true)
  await pi.event("turn_end")
  assert.equal(pi.messages.length, 0)
  assert.equal(pi.call("successful-code", "src/app.ts"), undefined)
  pi.result("successful-code")
  await pi.event("turn_end")
  assert.equal(pi.messages.length, 1)
  assert.deepEqual(pi.messages[0].message.details, { firstModel: "provider-a/model-a", secondModel: "provider-b/model-b", ...details })
  assert.ok(pi.messages[0].message.content.includes(details.planPath))
  assert.ok(pi.messages[0].message.content.includes(details.workspaceDir))
  assert.deepEqual(pi.messages[0].options, { deliverAs: "steer", triggerTurn: true })
  assert.match(pi.prompt(), /handoff is complete/)
  await pi.event("agent_settled")
  assert.ok(pi.prompt().includes(details.planPath))
  assert.doesNotMatch(pi.prompt(), /handoff is complete|Prewalk is armed/)
  await pi.command("provider-a/model-a provider-b/model-b")
  assert.deepEqual((await pi.allocate()).details, details)
  assert.equal(pi.call("rearm-code", "src/app.ts").block, true)
  assert.equal(pi.entries.length, 1)

  // A restart/compaction restores durable ownership, but never resumes Prewalk execution.
  const resumed = mockPi(adapter, project, "session-one", pi.entries)
  await resumed.event("session_start", { reason: "resume" })
  assert.ok(resumed.prompt().includes(details.planPath))
  assert.doesNotMatch(resumed.prompt(), /Prewalk is armed|handoff is complete/)
  await resumed.event("session_compact")
  assert.ok(resumed.prompt().includes(details.workspaceDir))
  await resumed.command("provider-a/model-a provider-b/model-b")
  assert.deepEqual((await resumed.allocate()).details, details)
  assert.equal(resumed.entries.length, 1)

  // Forks inherit custom entries, so session ID ownership must be checked.
  resumed.switchSession("session-fork")
  await resumed.event("session_start", { reason: "fork" })
  assert.equal(resumed.prompt(), undefined)
  await resumed.command("provider-a/model-a provider-b/model-b")
  assert.equal(resumed.call("old-plan", details.planPath).block, true)
  const fork = (await resumed.allocate()).details
  assert.notEqual(fork.workspaceDir, details.workspaceDir)
  assert.equal(resumed.call("parent-plan", details.planPath).block, true)
  assert.ok(resumed.prompt().includes(fork.planPath))
  assert.ok(!resumed.prompt().includes(details.planPath))

  resumed.switchSession("session-new", [])
  await resumed.event("session_start", { reason: "new" })
  assert.equal(resumed.prompt(), undefined)
  const fresh = (await resumed.allocate()).details
  assert.notEqual(fresh.workspaceDir, fork.workspaceDir)
  assert.notEqual(fresh.workspaceDir, details.workspaceDir)
}

async function testMissingRecordedDirectory(adapter) {
  const project = join(temporary, "missing-record-project")
  mkdirSync(project)
  const pi = mockPi(adapter, project, "session-one", [{ type: "custom", customType: "prewalk-workspace", data: { sessionId: "session-one", workspaceDir: join(project, "missing-folder") } }])
  await pi.event("session_start", { reason: "resume" })
  assert.match(pi.notifications[0].message, /could not restore/)
  await assert.rejects(pi.allocate(), /ENOENT/)
  assert.equal(pi.entries.length, 1)
}

async function testWorkspaceSymlinkBoundaries(adapter) {
  const project = join(temporary, "symlink-boundary-project")
  const outside = join(temporary, "outside-sessions")
  mkdirSync(project)
  mkdirSync(outside)
  mkdirSync(join(project, ".temp-local"))
  symlinkSync(outside, join(project, ".temp-local", "sessions"))
  const external = mockPi(adapter, project)
  await external.event("session_start", { reason: "startup" })
  await assert.rejects(external.allocate(), /inside this project/)
  assert.equal(external.entries.length, 0)
  assert.deepEqual(readdirSync(outside), [])

  rmSync(join(project, ".temp-local", "sessions"))
  rmSync(join(project, ".temp-local"), { recursive: true })
  symlinkSync(outside, join(project, ".temp-local"))
  const externalTemporaryRoot = mockPi(adapter, project, "session-two")
  await externalTemporaryRoot.event("session_start", { reason: "startup" })
  await assert.rejects(externalTemporaryRoot.allocate(), /inside this project/)
  assert.equal(externalTemporaryRoot.entries.length, 0)
  assert.deepEqual(readdirSync(outside), [])

  rmSync(join(project, ".temp-local"))
  const root = join(project, ".temp-local", "sessions")
  const sibling = join(root, "20261026-160000-other-session")
  mkdirSync(sibling, { recursive: true })
  const recordedPath = join(root, "20261026-160000-this-session")
  symlinkSync(sibling, recordedPath)
  const restored = mockPi(adapter, project, "session-one", [
    { type: "custom", customType: "prewalk-workspace", data: { sessionId: "session-one", workspaceDir: recordedPath } },
  ])
  await restored.event("session_start", { reason: "resume" })
  assert.match(restored.notifications[0].message, /could not restore/)
  await assert.rejects(restored.allocate(), /actual workspace directory/)
  assert.equal(restored.entries.length, 1)
}

async function testRestoreRejectsWorkspaceRootSymlinks(adapter) {
  for (const [name, linkName] of [["restore-sessions-link", "sessions"], ["restore-temp-link", ".temp-local"]]) {
    const project = join(temporary, name)
    const actualRoot = join(project, "workspace-data")
    const sessionRoot = join(actualRoot, "sessions")
    const recordedWorkspace = join(sessionRoot, "20261026-160000-restored-session")
    mkdirSync(recordedWorkspace, { recursive: true })
    if (linkName === "sessions") {
      mkdirSync(join(project, ".temp-local"))
      symlinkSync(sessionRoot, join(project, ".temp-local", "sessions"))
    } else {
      symlinkSync(actualRoot, join(project, ".temp-local"))
    }

    const restored = mockPi(adapter, project, "session-one", [
      { type: "custom", customType: "prewalk-workspace", data: { sessionId: "session-one", workspaceDir: recordedWorkspace } },
    ])
    await restored.event("session_start", { reason: "resume" })
    assert.equal(restored.notifications.length, 1)
    assert.match(restored.notifications[0].message, /could not restore/)
    await assert.rejects(restored.allocate(), /symbolic link/)
    assert.equal(restored.entries.length, 1)
  }
}

try {
  const adapter = await loadAdapter()
  await testLifecycle(adapter)
  await testMissingRecordedDirectory(adapter)
  await testWorkspaceSymlinkBoundaries(adapter)
  await testRestoreRejectsWorkspaceRootSymlinks(adapter)
  // A symlink-installed extension must find the canonical helper, without another installed link.
  const installed = join(temporary, "installed", "pi-prewalk.ts")
  mkdirSync(join(temporary, "installed"))
  symlinkSync(adapterFile, installed)
  const installedAdapter = await loadAdapter(installed)
  const project = join(temporary, "symlink-project")
  mkdirSync(project)
  const pi = mockPi(installedAdapter, project)
  await pi.event("session_start", { reason: "startup" })
  assert.match((await pi.allocate("symlink-install")).details.workspaceDir, /symlink-install$/)
  console.log("All Prewalk adapter tests passed.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
