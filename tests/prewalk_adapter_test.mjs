import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempCwds = new Set()
test.afterEach(() => {
  for (const cwd of tempCwds) rmSync(cwd, { recursive: true, force: true })
  tempCwds.clear()
})
const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())
const piRoot = dirname(dirname(dirname(piCli)))
const { createJiti } = await import(pathToFileURL(resolve(piRoot, "node_modules/jiti/lib/jiti.mjs")).href)
const jiti = createJiti(import.meta.url, { alias: { typebox: `${piRoot}/node_modules/typebox/build/index.mjs` } })

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "prewalk-adapter-"))
  tempCwds.add(cwd)
  execFileSync("git", ["init", "-q"], { cwd })
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const appended = []
  const messages = []
  let aborts = 0
  const models = [
    { provider: "mock", id: "frontier" },
    { provider: "mock", id: "cheap" },
  ]
  const pi = {
    on(name, handler) { handlers.set(name, handler) },
    registerTool(tool) { tools.set(tool.name, tool) },
    registerCommand(name, command) { commands.set(name, command) },
    appendEntry(type, data) { appended.push({ customType: type, data }) },
    sendMessage(message, options) { messages.push({ message, options }) },
    sendUserMessage(message, options) { messages.push({ message, options, user: true }) },
    async setModel(model) { pi.currentModel = model; return true },
    currentModel: models[0],
  }
  const ctx = {
    cwd,
    abort() { aborts++ },
    mode: "print",
    hasUI: false,
    ui: { notify() {}, confirm: async () => true },
    model: models[0],
    modelRegistry: { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) },
    sessionManager: { getSessionId: () => "session-test", getBranch: () => appended.map((entry) => ({ type: "custom", ...entry })) },
  }
  return { pi, ctx, handlers, tools, commands, appended, messages, aborts: () => aborts }
}

async function enterFrontierReview(mock, goal = "Review the task") {
  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: goal, systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  const planPath = join(mock.ctx.cwd, ".temp-local", "workflow-plan.md")
  mock.handlers.get("tool_call")({ toolCallId: "write-plan", toolName: "write", input: { path: planPath } }, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "write-plan", toolName: "write", isError: false }, mock.ctx)
  const plan = {
    hardContract: { outcome: "Implement feature", constraints: [], allowedPaths: ["src/"], protectedPaths: ["package.json"] },
    softPlan: { expectedFiles: ["src/a.mjs"] },
    phases: [{ id: "phase-1", todos: [{ id: "todo-1", text: "Implement", status: "pending" }], checks: [
      { id: "check-1", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: mock.ctx.cwd, required: true },
    ] }],
  }
  const proposal = await mock.tools.get("prewalk_checkpoint").execute("plan", { action: "submit_plan", plan }, undefined, undefined, mock.ctx)
  assert.equal(proposal.details.ok, true)
  await mock.commands.get("prewalk").handler(`approve ${proposal.details.proposalId}`, mock.ctx)
  mock.handlers.get("tool_call")({ toolCallId: "edit-initial", toolName: "edit", input: { path: join(mock.ctx.cwd, "src/a.mjs") } }, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "edit-initial", toolName: "edit", isError: false }, mock.ctx)
  await mock.handlers.get("turn_end")({ messageEntryId: "first-turn", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
  const blocked = mock.handlers.get("tool_call")({ toolCallId: "blocked-change", toolName: "edit", input: { path: join(mock.ctx.cwd, "package.json") } }, mock.ctx)
  assert.equal(blocked.block, true)
  await mock.handlers.get("turn_end")({ messageEntryId: "cheap-turn", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
}


test("Pi adapter registers tools/events; arming waits for a real task prompt", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)

  assert.deepEqual([...mock.tools.keys()].sort(), ["prewalk_checkpoint", "prewalk_validate"])
  assert.ok(mock.commands.has("prewalk"))
  for (const name of ["tool_call", "tool_result", "turn_start", "turn_end", "agent_before_settle", "session_start", "session_tree", "model_select", "context", "before_agent_start"]) assert.ok(mock.handlers.has(name), `missing ${name}`)

  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  assert.equal(mock.appended.length, 0, "arming alone must not create a run")
  const promptEvent = { prompt: "Implement adapter behavior", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }
  const beforeStart = await mock.handlers.get("before_agent_start")(promptEvent, mock.ctx)
  assert.equal(beforeStart, undefined)
  assert.match(promptEvent.systemPromptOptions.appendSystemPrompt, /submit_plan/)
  assert.equal(mock.appended[0].customType, "prewalk-state")
  assert.equal(mock.appended[0].data.state.goal, "Implement adapter behavior")

  // Turn lifecycle callbacks are wired with stable event IDs; idle model selection is not a task approval.
  await mock.handlers.get("turn_start")({ turnIndex: 1 }, mock.ctx)
  await mock.handlers.get("model_select")({ model: { provider: "mock", id: "cheap" }, source: "cycle" }, mock.ctx)
  assert.ok(mock.appended.some((entry) => entry.customType === "prewalk-audit"))
})

test("a new agent run may reuse turnIndex without losing accounting or batch observation", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: "Task", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  const turnStart = mock.handlers.get("turn_start")
  const turnEnd = mock.handlers.get("turn_end")
  for (const entryId of ["response-1", "response-2"]) {
    await turnStart({ turnIndex: 0, timestamp: Date.now() }, mock.ctx)
    await turnEnd({ turnIndex: 0, messageEntryId: entryId, toolResultEntryIds: [], message: { role: "assistant", provider: "mock", model: "frontier", usage: { input: 1, output: 2, cost: { total: 0.01 } } } }, mock.ctx)
  }
  const last = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(last.step_count, 2)
  assert.equal(last.usage.length, 2)
})

test("restored runs do not reuse pre-reload turn event IDs", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  const command = mock.commands.get("prewalk").handler
  await command("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: "Task", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  await mock.handlers.get("turn_start")({ turnIndex: 0 }, mock.ctx)
  await mock.handlers.get("session_start")({ reason: "resume" }, mock.ctx)
  await command("resume", mock.ctx)
  await mock.handlers.get("turn_start")({ turnIndex: 0 }, mock.ctx)
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(state.step_count, 2)
})

test("session shutdown preserves resumable state and the current branch is authoritative", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: "Task", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  assert.equal(mock.handlers.has("session_shutdown"), false, "shutdown must not turn a resumable task into a terminal stop")
  const last = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(last.stage, "frontier_plan")
  await mock.handlers.get("session_start")({ reason: "resume" }, mock.ctx)
  assert.ok(mock.appended.some((entry) => entry.data?.state?.stage === "paused"))
})

test("a stopped task can arm a separate new task in the same session", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  const command = mock.commands.get("prewalk").handler
  await command("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: "First task", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  const firstId = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.runId
  await command("off", mock.ctx)
  await command("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: "Second task", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(state.goal, "Second task")
  assert.notEqual(state.runId, firstId)
})

test("review context retains mandatory user text and bounded evidence without aborting", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock)
  const result = await mock.handlers.get("context")({ messages: [
    { role: "user", content: "Preserve the approved boundary" },
    { role: "custom", content: "x".repeat(40000), customType: "optional", display: false, timestamp: 0 },
  ] }, mock.ctx)
  assert.equal(mock.aborts(), 0)
  assert.equal(result.messages[0].role, "user")
  assert.equal(result.messages.some((message) => message.customType === "optional"), false)
  assert.ok(result.messages.at(-1).content.includes("Hard contract:"))
  const budget = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.config.contextBudgetChars
  assert.ok(result.messages.reduce((total, message) => total + JSON.stringify(message).length, 0) <= budget)
})

test("oversized mandatory user history aborts the current request and durably stops routing", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "frontier_review")
  const result = await mock.handlers.get("context")({ messages: [{ role: "user", content: "x".repeat(40000) }] }, mock.ctx)
  assert.equal(result, undefined)
  assert.equal(mock.aborts(), 1)
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(state.stage, "stopped")
  assert.equal(state.stopReason, "mandatory-context-exceeds-budget")
})

test("an oversized structured review prompt stops before queuing a Frontier turn", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock, "x".repeat(40000))
  assert.equal(mock.aborts(), 1)
  assert.equal(mock.messages.filter((entry) => entry.message.customType === "prewalk-routing" && entry.message.content.includes("FRONTIER REVIEW")).length, 0)
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(state.stage, "stopped")
  assert.equal(state.stopReason, "mandatory-context-exceeds-budget")
})

test("installed Pi loader loads the extension without a session or credentials", () => {
  const home = mkdtempSync(`${tmpdir()}/prewalk-pi-home-`)
  try {
    execFileSync("pi", ["--extension", resolve(root, "extensions/pi-prewalk.ts"), "--no-session", "--print", ""], {
      cwd: root,
      env: { ...process.env, HOME: home },
      stdio: "pipe",
      timeout: 20000,
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
