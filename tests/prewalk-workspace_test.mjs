// Verifies the session workspace tool grafted into the routing adapter:
// allocation via Planning's helper, same-session reuse, prompt injection,
// restore after reload, and a separate folder for forked sessions.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(import.meta.dirname, "..")
const adapterFile = join(root, "extensions/pi-prewalk.ts")

async function loadAdapter() {
  const source = readFileSync(adapterFile, "utf8")
    .replace('import { Type } from "typebox"', 'const Type = { Object: (properties, options) => ({ type: "object", properties, ...options }), String: (options) => ({ type: "string", ...options }), Optional: (inner) => inner, Array: (items, options) => ({ type: "array", items, ...options }), Any: () => ({}) }')
    .replace('from "./prewalk-core.mjs"', `from ${JSON.stringify(pathToFileURL(join(root, "extensions/prewalk-core.mjs")).href)}`)
    .replace('from "./prewalk-runtime.mjs"', `from ${JSON.stringify(pathToFileURL(join(root, "extensions/prewalk-runtime.mjs")).href)}`)
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(adapterFile).href))
  const javascript = stripTypeScriptTypes(source, { mode: "strip" })
  return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)).default
}

function mockPi(adapter, projectDirectory, sessionId = "session-one", persistedEntries = []) {
  const handlers = new Map()
  const tools = new Map()
  const entries = [...persistedEntries]
  const ctx = {
    cwd: projectDirectory,
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => entries },
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    ui: { notify: () => {}, setStatus: () => {} },
  }
  adapter({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    setModel: async () => true,
    sendMessage: () => {},
  })
  return { handlers, tools, entries, ctx }
}

const adapter = await loadAdapter()
const project = realpathSync(mkdtempSync(join(tmpdir(), "prewalk-workspace-")))
try {
  const pi = mockPi(adapter, project)
  await pi.handlers.get("session_start")({}, pi.ctx)
  assert.ok(pi.tools.has("prewalk_workspace"), "prewalk_workspace tool is registered")
  assert.ok(pi.tools.has("prewalk_checkpoint"), "prewalk_checkpoint tool is still registered")

  const first = await pi.tools.get("prewalk_workspace").execute("1", { description: "plan-isolation" }, undefined, undefined, pi.ctx)
  const workspaceDir = first.details.workspaceDir
  assert.ok(workspaceDir.includes(join(".temp-local", "sessions")), "workspace is under .temp-local/sessions")
  assert.ok(existsSync(workspaceDir), "workspace directory exists")
  assert.equal(first.details.planPath, join(workspaceDir, "workflow-plan.md"))

  const second = await pi.tools.get("prewalk_workspace").execute("2", { description: "other-task" }, undefined, undefined, pi.ctx)
  assert.equal(second.details.workspaceDir, workspaceDir, "same session reuses its folder")

  const event = { prompt: "hello", systemPromptOptions: {} }
  await pi.handlers.get("before_agent_start")(event, pi.ctx)
  assert.ok(event.systemPromptOptions.appendSystemPrompt?.includes(workspaceDir), "prompt names the session workspace")
  assert.ok(event.systemPromptOptions.appendSystemPrompt?.includes("workflow-plan.md"), "prompt names the exact plan path")

  const reloaded = mockPi(adapter, project, "session-one", pi.entries)
  await reloaded.handlers.get("session_start")({}, reloaded.ctx)
  const third = await reloaded.tools.get("prewalk_workspace").execute("3", { description: "whatever" }, undefined, undefined, reloaded.ctx)
  assert.equal(third.details.workspaceDir, workspaceDir, "restored session reuses its folder")

  const forked = mockPi(adapter, project, "session-two", pi.entries)
  await forked.handlers.get("session_start")({}, forked.ctx)
  const fourth = await forked.tools.get("prewalk_workspace").execute("4", { description: "fork-task" }, undefined, undefined, forked.ctx)
  assert.notEqual(fourth.details.workspaceDir, workspaceDir, "forked session allocates its own folder")
} finally {
  rmSync(project, { recursive: true, force: true })
}
console.log("prewalk-workspace tests passed")
