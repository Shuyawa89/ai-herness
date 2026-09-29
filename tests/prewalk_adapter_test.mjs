import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
  const notices = []
  const statuses = []
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
    thinkingLevel: "xhigh",
    ui: {
      notify(text, kind) { notices.push({ text, kind }) }, confirm: async () => true,
      setStatus(key, text) { statuses.push({ key, text }) },
      theme: { bold: (text) => `<bold>${text}</bold>`, fg: (kind, text) => `<${kind}>${text}</${kind}>` },
    },
    model: models[0],
    modelRegistry: { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) },
    sessionManager: { getSessionId: () => "session-test", getBranch: () => appended.map((entry) => ({ type: "custom", ...entry })) },
  }
  return { pi, ctx, handlers, tools, commands, appended, messages, notices, statuses, aborts: () => aborts }
}

async function enterPlanProposal(mock, goal = "Review the task") {
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
  return { proposal, plan }
}

async function enterFrontierReview(mock, goal = "Review the task") {
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  await enterPlanProposal(mock, goal)
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
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
  for (const name of ["tool_call", "tool_result", "turn_start", "turn_end", "agent_before_settle", "session_start", "session_tree", "model_select", "thinking_level_select", "context", "before_agent_start"]) assert.ok(mock.handlers.has(name), `missing ${name}`)

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
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "frontier_plan")
  await mock.handlers.get("turn_start")({ turnIndex: 0 }, mock.ctx)
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(state.step_count, 2)
})

test("session reload resumes the matching branch without a command, but never restarts a stopped task", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  await mock.handlers.get("before_agent_start")({ prompt: "Task", systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  assert.equal(mock.handlers.has("session_shutdown"), false, "shutdown must not turn a resumable task into a terminal stop")
  const last = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(last.stage, "frontier_plan")
  await mock.handlers.get("session_start")({ reason: "resume" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "frontier_plan")
  assert.equal(mock.messages.length, 0, "restoring should wait for user input, not start an unsolicited turn")
  await mock.commands.get("prewalk").handler("off", mock.ctx)
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "stopped")
})

test("an implementation-stage reload selects Cheap without starting an unsolicited turn", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock)
  const continuation = await mock.tools.get("prewalk_checkpoint").execute("continue", { action: "verdict", phaseId: "phase-1", verdict: "continue" }, undefined, undefined, mock.ctx)
  assert.equal(continuation.details.ok, true)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "cheap_pending")
  mock.pi.currentModel = mock.ctx.model
  const messagesBefore = mock.messages.length
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(mock.pi.currentModel.id, "cheap")
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "cheap_pending")
  assert.equal(mock.messages.length, messagesBefore)
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

test("interactive affirmative input approves only the previewed initial proposal", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  for (const phrase of ["承認", "OK", "ok", "いいよ", "進めて", "この計画で進めて"]) {
    const mock = setup()
    mock.ctx.mode = "tui"; mock.ctx.hasUI = true
    extension(mock.pi)
    const { proposal } = await enterPlanProposal(mock, "機能を実装して")
    assert.ok(mock.notices.some(({ text }) => text.includes("Implement feature")), `missing preview: ${phrase}`)
    const result = await mock.handlers.get("input")({ text: phrase, source: "interactive" }, mock.ctx)
    assert.deepEqual(result, { action: "handled" })
    const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
    assert.equal(state.initialApproval.proposalId, proposal.details.proposalId)
    assert.equal(state.stage, "frontier_initial")
  }
})

test("a revision replaces the previewed initial plan and requires approval of the replacement", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal: initial, plan } = await enterPlanProposal(mock, "機能を実装して")
  const revisionPrompt = { prompt: "テストを追加する計画に修正して", systemPromptOptions: { appendSystemPrompt: "" } }
  await mock.handlers.get("before_agent_start")(revisionPrompt, mock.ctx)
  assert.match(revisionPrompt.systemPromptOptions.appendSystemPrompt, /revised initial plan/)
  const revisedPlan = { ...plan, hardContract: { ...plan.hardContract, outcome: "Implement feature with tests" } }
  const revisionInput = { action: "submit_plan", plan: revisedPlan }
  assert.equal(mock.handlers.get("tool_call")({ toolCallId: "revised-plan", toolName: "prewalk_checkpoint", input: revisionInput }, mock.ctx), undefined)
  const revised = await mock.tools.get("prewalk_checkpoint").execute("revised-plan", revisionInput, undefined, undefined, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "revised-plan", toolName: "prewalk_checkpoint", isError: false }, mock.ctx)

  assert.equal(revised.details.ok, true)
  const pending = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.proposals
  assert.equal(pending.find((proposal) => proposal.id === initial.details.proposalId).status, "superseded")
  assert.equal(pending.find((proposal) => proposal.id === revised.details.proposalId).status, "pending")
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "handled" })
  const approved = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(approved.initialApproval.proposalId, revised.details.proposalId)
  assert.equal(approved.plan.hardContract.outcome, "Implement feature with tests")
})

test("a pending plan returns to conversation after reload; revision supersedes it before approval", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal: original, plan } = await enterPlanProposal(mock, "機能を実装して")
  const previews = mock.notices.filter(({ text }) => text.includes("目標: Implement feature")).length
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(plan\)/)
  assert.ok(mock.notices.filter(({ text }) => text.includes("目標: Implement feature")).length > previews)
  assert.equal(mock.messages.length, 0)
  const revisionPrompt = { prompt: "テストを追加する計画に修正して", systemPromptOptions: { appendSystemPrompt: "" } }
  await mock.handlers.get("before_agent_start")(revisionPrompt, mock.ctx)
  assert.match(revisionPrompt.systemPromptOptions.appendSystemPrompt, /revised initial plan/)
  const revisionInput = { action: "submit_plan", plan: { ...plan, hardContract: { ...plan.hardContract, outcome: "Implement feature with tests" } } }
  assert.equal(mock.handlers.get("tool_call")({ toolCallId: "revision", toolName: "prewalk_checkpoint", input: revisionInput }, mock.ctx), undefined)
  const revised = await mock.tools.get("prewalk_checkpoint").execute("revision", revisionInput, undefined, undefined, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "revision", toolName: "prewalk_checkpoint", isError: false }, mock.ctx)
  assert.equal(revised.details.ok, true)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.proposals.find((item) => item.id === original.details.proposalId).status, "superseded")
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "handled" })
  const approved = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(approved.initialApproval.proposalId, revised.details.proposalId)
})

test("reload selects the saved run's model before resuming, and stays paused if selection fails", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterPlanProposal(mock)
  mock.ctx.model = { provider: "mock", id: "cheap" }
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(mock.pi.currentModel.id, "frontier")
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "awaiting_approval")
  mock.pi.setModel = async () => false
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "paused")
  assert.match(mock.notices.at(-1).text, /required model/)
  mock.pi.setModel = async () => { throw new Error("model offline") }
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "paused")
  assert.match(mock.notices.at(-1).text, /required model/)
})

test("a different session cannot restore or approve the prior session's plan", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock)
  mock.ctx.sessionManager.getSessionId = () => "new-session"
  await mock.handlers.get("session_start")({ reason: "switch" }, mock.ctx)
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval, null)
  assert.equal(mock.statuses.at(-1).text, undefined)
})

test("returning to a plan branch re-displays its proposal without approving the other branch", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal } = await enterPlanProposal(mock)
  const originalSession = mock.ctx.sessionManager.getSessionId
  mock.ctx.sessionManager.getSessionId = () => "other-session"
  await mock.handlers.get("session_tree")({ reason: "branch" }, mock.ctx)
  assert.equal(mock.statuses.at(-1).text, undefined)
  mock.ctx.sessionManager.getSessionId = originalSession
  await mock.handlers.get("session_tree")({ reason: "branch" }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(plan\)/)
  assert.ok(mock.notices.at(-1).text.includes("Implement feature"))
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval.proposalId, proposal.details.proposalId)
})

test("affirmative words never approve injected, ambiguous, image, stale, or paused input", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "日本語で実装して")
  for (const event of [
    { text: "OK", source: "extension" }, { text: "OK", source: "rpc" },
    { text: "いいよ、ただしDBは触らないで", source: "interactive" },
    { text: "承認していい？", source: "interactive" },
    { text: "OK", source: "interactive", images: [{ type: "image", data: "x", mimeType: "image/png" }] },
  ]) {
    await mock.handlers.get("input")(event, mock.ctx)
    assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval, null)
  }
  writeFileSync(join(mock.ctx.cwd, "new-file"), "changed")
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "stopped")
})

test("multiple pending proposals and session mismatch cannot be approved by affirmative input", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock)
  const actualSession = mock.ctx.sessionManager.getSessionId
  mock.ctx.sessionManager.getSessionId = () => "different-session"
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval, null)
  mock.ctx.sessionManager.getSessionId = actualSession
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  mock.pi.appendEntry("prewalk-state", { version: 1, state: { ...state, stateRevision: state.stateRevision + 1, proposals: [...state.proposals, { ...state.proposals.at(-1), id: "another-proposal" }] } })
  await mock.handlers.get("session_tree")({ reason: "branch" }, mock.ctx)
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval, null)
})

test("plan presentation follows the task language and survives restoration", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal } = await enterPlanProposal(mock, "機能を日本語で実装して")
  assert.ok(mock.notices.some(({ text }) => text.includes("計画") && text.includes("目標: Implement feature") && !text.includes("hardContract")))
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.match(readFileSync(join(mock.ctx.cwd, ".temp-local/workflow-plan.md"), "utf8"), /## (作業フェーズ|フェーズ)[\s\S]*検証/)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval.proposalId, proposal.details.proposalId)
  await mock.commands.get("prewalk").handler("status", mock.ctx)
  assert.ok(mock.notices.at(-1).text.includes("目標: Implement feature"))
  assert.ok(!mock.notices.at(-1).text.includes("hardContract"))
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.match(readFileSync(join(mock.ctx.cwd, ".temp-local/workflow-plan.md"), "utf8"), /## (作業フェーズ|フェーズ)/)
})

test("hard-boundary approval is scoped, and a decision question is not an approval", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterFrontierReview(mock, "変更の範囲を確認して")
  const hard = await mock.tools.get("prewalk_checkpoint").execute("scope", { action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "docs/"] } }, undefined, undefined, mock.ctx)
  assert.equal(hard.details.ok, true)
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(scope\)/)
  assert.ok(mock.notices.some(({ text }) => text.includes("作業範囲の変更") && text.includes("変更後") && text.includes("docs/") && !text.includes("allowedPaths")))
  mock.ctx.model = { provider: "mock", id: "cheap" }
  mock.pi.currentModel = mock.ctx.model
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(mock.pi.currentModel.id, "frontier", "scope approval must return to Frontier review")
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(scope\)/)
  await mock.handlers.get("input")({ text: "この変更で進めて", source: "interactive" }, mock.ctx)
  const approved = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.deepEqual(approved.hardContract.allowedPaths, ["src/", "docs/"])
  const decision = await mock.tools.get("prewalk_checkpoint").execute("question", { action: "verdict", verdict: "needs-human", reason: "Which API?" }, undefined, undefined, mock.ctx)
  assert.equal(decision.details.ok, true)
  assert.match(mock.statuses.at(-1).text, /Awaiting decision/)
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "awaiting_human_approval")
})

test("final review requires a fresh check and an explicit completion approval", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "Complete the task")
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  mock.handlers.get("tool_call")({ toolCallId: "edit-initial", toolName: "edit", input: { path: join(mock.ctx.cwd, "src/a.mjs") } }, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "edit-initial", toolName: "edit", isError: false }, mock.ctx)
  await mock.handlers.get("turn_end")({ messageEntryId: "initial", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
  const result = await mock.tools.get("prewalk_validate").execute("check-run", { checkId: "check-1" })
  assert.equal(result.details.status, "passed")
  const progress = await mock.tools.get("prewalk_checkpoint").execute("ready", { action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] }, undefined, undefined, mock.ctx)
  assert.equal(progress.details.ok, true)
  await mock.handlers.get("turn_end")({ messageEntryId: "ready", toolResultEntryIds: ["ready"], message: { role: "assistant" } }, mock.ctx)
  const state = mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state
  assert.equal(state.stage, "frontier_review")
  const verdict = await mock.tools.get("prewalk_checkpoint").execute("final", { action: "verdict", phaseId: "phase-1", verdict: "pass" }, undefined, undefined, mock.ctx)
  assert.equal(verdict.details.ok, true)
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(final\)/)
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(final\)/)
  await mock.handlers.get("input")({ text: "進めて", source: "interactive" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "awaiting_final_approval")
  await mock.handlers.get("input")({ text: "完了を承認", source: "interactive" }, mock.ctx)
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.stage, "complete")
  assert.match(mock.statuses.at(-1).text, /<bold>Done<\/bold>/)
})

test("English task retains English plan headings", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "Implement this feature")
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.match(readFileSync(join(mock.ctx.cwd, ".temp-local/workflow-plan.md"), "utf8"), /## Phases/)
})

test("Pi status uses compact model names, current thinking, and a single stage indicator", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  assert.match(mock.statuses.at(-1).text, /F:frontier.*C:cheap.*T:xhigh/)
  await mock.handlers.get("before_agent_start")({ prompt: "Implement", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /^Prewalk: <accent><bold>Plan<\/bold><\/accent> →/)
  assert.match(mock.statuses.at(-1).text, /<dim>Build<\/dim>/)
  mock.ctx.thinkingLevel = "high"
  await mock.handlers.get("thinking_level_select")({ level: "high", previousLevel: "xhigh" }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /T:high/)
  const planPath = join(mock.ctx.cwd, ".temp-local/workflow-plan.md")
  mock.handlers.get("tool_call")({ toolCallId: "write-plan", toolName: "write", input: { path: planPath } }, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "write-plan", toolName: "write", isError: false }, mock.ctx)
  const plan = { hardContract: { outcome: "Do work", constraints: [], allowedPaths: ["src/"], protectedPaths: [] }, softPlan: {}, phases: [{ id: "one", todos: [{ id: "task", text: "Work" }], evidenceRequired: ["src/out"] }] }
  await mock.tools.get("prewalk_checkpoint").execute("plan", { action: "submit_plan", plan }, undefined, undefined, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /Awaiting approval \(plan\)/)
  const tui = await import(pathToFileURL(resolve(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href)
  assert.match(tui.truncateToWidth(mock.statuses.at(-1).text, 55, "..."), /Awaiting approval/)
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /<bold>First edit<\/bold>/)
  await mock.commands.get("prewalk").handler("status", mock.ctx)
  assert.match(mock.notices.at(-1).text, /mock\/frontier/)
  assert.match(mock.notices.at(-1).text, /mock\/cheap/)
  const { truncateToWidth, visibleWidth } = await import(pathToFileURL(resolve(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href)
  const narrow = truncateToWidth(mock.statuses.at(-1).text, 38, "...")
  assert.ok(visibleWidth(narrow) <= 38)
  assert.ok(!narrow.includes("mock/cheap"), "a narrow footer must not be the only place for full model IDs")
  await mock.commands.get("prewalk").handler("off", mock.ctx)
  assert.deepEqual(mock.statuses.at(-1), { key: "prewalk", text: undefined })
})

test("idle, noninteractive, and uncertain approval controls preserve the boundary", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  const command = mock.commands.get("prewalk").handler
  await command("status", mock.ctx)
  assert.match(mock.notices.at(-1).text, /idle/)
  await command("resume", mock.ctx)
  assert.match(mock.notices.at(-1).text, /Usage:/)
  await command("mock/frontier mock/cheap", mock.ctx)
  await command("status", mock.ctx)
  assert.match(mock.notices.at(-1).text, /Armed/)
  await mock.handlers.get("before_agent_start")({ prompt: "Task", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "continue" })
  await command("approve", mock.ctx)
  assert.match(mock.notices.at(-1).text, /Usage:/)
  await command("approve fake-id", mock.ctx)
  assert.match(mock.notices.at(-1).text, /Usage:/)
  await command("reject fake-id", mock.ctx)
  assert.match(mock.notices.at(-1).text, /Usage:/)
  const planPath = join(mock.ctx.cwd, ".temp-local/workflow-plan.md")
  mock.handlers.get("tool_call")({ toolCallId: "write-plan", toolName: "write", input: { path: planPath } }, mock.ctx)
  mock.handlers.get("tool_result")({ toolCallId: "write-plan", toolName: "write", isError: false }, mock.ctx)
  const plan = { hardContract: { outcome: "Task", constraints: [], allowedPaths: [], protectedPaths: [] }, softPlan: {}, phases: [{ id: "one", todos: [{ id: "do", text: "Do it" }], evidenceRequired: ["result.txt"] }] }
  await mock.tools.get("prewalk_checkpoint").execute("plan", { action: "submit_plan", plan }, undefined, undefined, mock.ctx)
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1).data.state.initialApproval, null)
})

test("explicit English instruction overrides a Japanese task for plan presentation", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "日本語の依頼だが plan は英語で書いて")
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.match(readFileSync(join(mock.ctx.cwd, ".temp-local/workflow-plan.md"), "utf8"), /## Phases/)
})

test("review stage is restored without falsely highlighting build", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterFrontierReview(mock)
  assert.match(mock.statuses.at(-1).text, /<bold>Review<\/bold>/)
  assert.match(mock.statuses.at(-1).text, /<dim>Build \(1\/1\)<\/dim>/)
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.match(mock.statuses.at(-1).text, /<bold>Review<\/bold>/)
  assert.doesNotMatch(mock.statuses.at(-1).text, /<bold>Build<\/bold>/)
})

function latestState(mock) {
  return mock.appended.filter((entry) => entry.customType === "prewalk-state").at(-1)?.data.state
}

async function enterFinalProposal(mock) {
  await enterFrontierReview(mock, "機能を実装して")
  await mock.tools.get("prewalk_checkpoint").execute("continue", { action: "verdict", phaseId: "phase-1", verdict: "continue" }, undefined, undefined, mock.ctx)
  await mock.handlers.get("turn_end")({ messageEntryId: "continue", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
  await mock.tools.get("prewalk_validate").execute("check", { checkId: "check-1" })
  await mock.tools.get("prewalk_checkpoint").execute("ready", { action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] }, undefined, undefined, mock.ctx)
  await mock.handlers.get("turn_end")({ messageEntryId: "ready-final", toolResultEntryIds: ["ready"], message: { role: "assistant" } }, mock.ctx)
  const result = await mock.tools.get("prewalk_checkpoint").execute("pass", { action: "verdict", phaseId: "phase-1", verdict: "pass" }, undefined, undefined, mock.ctx)
  assert.equal(result.details.ok, true)
}

test("off and reload leave ordinary tools, plan files, and turns untouched", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock)
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  mock.handlers.get("tool_call")({ toolCallId: "late-edit", toolName: "edit", input: { path: "src/a.mjs" } }, mock.ctx)
  await mock.commands.get("prewalk").handler("off", mock.ctx)
  const stopped = latestState(mock)
  const planPath = join(mock.ctx.cwd, ".temp-local/workflow-plan.md")
  const planBefore = readFileSync(planPath, "utf8")
  for (const reload of [false, true]) {
    if (reload) await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
    const entries = mock.appended.length, messages = mock.messages.length, notices = mock.notices.length
    const prompt = { prompt: "普通の作業を続けて", systemPromptOptions: { appendSystemPrompt: "" } }
    await mock.handlers.get("before_agent_start")(prompt, mock.ctx)
    await mock.handlers.get("turn_start")({}, mock.ctx)
    for (const toolName of ["read", "bash", "edit", "write"]) {
      assert.equal(mock.handlers.get("tool_call")({ toolCallId: `ordinary-${toolName}`, toolName, input: { path: "src/a.mjs", command: "pwd" } }, mock.ctx), undefined)
    }
    mock.handlers.get("tool_result")({ toolCallId: "late-edit", toolName: "edit", isError: false }, mock.ctx)
    mock.handlers.get("tool_result")({ toolCallId: "late-checkpoint", toolName: "prewalk_checkpoint", isError: false }, mock.ctx)
    await mock.handlers.get("turn_end")({ messageEntryId: `ordinary-${reload}`, toolResultEntryIds: ["late-edit"], message: { role: "assistant", usage: { input: 3 } } }, mock.ctx)
    await mock.handlers.get("thinking_level_select")({}, mock.ctx)
    assert.equal(prompt.systemPromptOptions.appendSystemPrompt, "")
    assert.equal(mock.appended.length, entries)
    assert.equal(mock.messages.length, messages)
    assert.equal(mock.notices.length, notices)
    assert.equal(mock.statuses.at(-1).text, undefined)
    assert.deepEqual(latestState(mock), stopped)
    assert.equal(readFileSync(planPath, "utf8"), planBefore)
  }
})

test("a stopped run also leaves ordinary Pi events inert after checkpoint cancellation", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterPlanProposal(mock)
  const cancelled = await mock.tools.get("prewalk_checkpoint").execute("cancel", { action: "cancel" }, undefined, undefined, mock.ctx)
  assert.equal(cancelled.details.ok, undefined)
  const stopped = latestState(mock)
  assert.equal(stopped.stage, "stopped")
  const entries = mock.appended.length
  for (const toolName of ["read", "bash", "edit", "write", "third-party"]) {
    assert.equal(mock.handlers.get("tool_call")({ toolCallId: `stopped-${toolName}`, toolName, input: { path: "unrelated/file", command: "pwd" } }, mock.ctx), undefined)
  }
  assert.equal(await mock.handlers.get("context")({ messages: [] }, mock.ctx), undefined)
  await mock.handlers.get("model_select")({ model: { provider: "mock", id: "cheap" }, source: "cycle" }, mock.ctx)
  await mock.handlers.get("turn_start")({}, mock.ctx)
  assert.equal(mock.appended.length, entries)
  assert.deepEqual(latestState(mock), stopped)
})

test("a mid-work revision shows changed checks and resumes Cheap only after human approval and Frontier confirmation", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock)
  const continueReview = await mock.tools.get("prewalk_checkpoint").execute("continue", { action: "verdict", phaseId: "phase-1", verdict: "continue" }, undefined, undefined, mock.ctx)
  assert.equal(continueReview.details.ok, true)
  await mock.handlers.get("turn_end")({ messageEntryId: "cheap-again", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
  assert.equal(latestState(mock).stage, "cheap")
  const requested = await mock.tools.get("prewalk_checkpoint").execute("request", { action: "request_revision", reason: "Change the required check" }, undefined, undefined, mock.ctx)
  assert.equal(requested.details.ok, true)
  await mock.handlers.get("turn_end")({ messageEntryId: "revision-review", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
  assert.equal(latestState(mock).stage, "frontier_review")
  const current = latestState(mock)
  const newPlan = structuredClone(current.plan)
  newPlan.phases[0].checks[0].args = ["-e", "process.exit(1)"]
  newPlan.phases[0].checks[0].required = false
  const revised = await mock.tools.get("prewalk_checkpoint").execute("proposal", { action: "propose", kind: "plan", patch: newPlan }, undefined, undefined, mock.ctx)
  assert.equal(revised.details.ok, true)
  assert.match(mock.notices.at(-1).text, /process\.exit\(0\)/)
  assert.match(mock.notices.at(-1).text, /process\.exit\(1\)/)
  assert.match(mock.notices.at(-1).text, /required: true/)
  assert.match(mock.notices.at(-1).text, /required: false/)
  assert.ok(mock.notices.at(-1).text.includes(`cwd: ${mock.ctx.cwd}`))
  assert.equal(latestState(mock).phases[0].checks[0].args.at(-1), "process.exit(0)")
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(latestState(mock).stage, "frontier_review")
  assert.equal(latestState(mock).phases[0].checks[0].args.at(-1), "process.exit(1)")
  assert.match(readFileSync(join(mock.ctx.cwd, ".temp-local/workflow-plan.md"), "utf8"), /required: false/)
  const confirmationPrompt = { prompt: "Continue", systemPromptOptions: { appendSystemPrompt: "" } }
  await mock.handlers.get("before_agent_start")(confirmationPrompt, mock.ctx)
  assert.match(confirmationPrompt.systemPromptOptions.appendSystemPrompt, /This revised plan already has direct human approval/)
  const confirm = await mock.tools.get("prewalk_checkpoint").execute("confirm", { action: "verdict", phaseId: "phase-1", verdict: "continue" }, undefined, undefined, mock.ctx)
  assert.equal(confirm.details.ok, true)
  await mock.handlers.get("turn_end")({ messageEntryId: "revised-cheap", toolResultEntryIds: [], message: { role: "assistant" } }, mock.ctx)
  assert.equal(latestState(mock).stage, "cheap")
  assert.equal(latestState(mock).runId, current.runId)
})

test("mid-work plan proposals reject injected approvals, require fresh input after reload, and preserve the plan on NG", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock)
  const prior = structuredClone(latestState(mock).phases)
  const patch = structuredClone(latestState(mock).plan)
  patch.phases[0].checks[0].required = false
  const proposal = await mock.tools.get("prewalk_checkpoint").execute("revised-plan", { action: "propose", kind: "plan", patch }, undefined, undefined, mock.ctx)
  assert.equal(proposal.details.ok, true)
  for (const input of [
    { text: "OK", source: "extension" },
    { text: "OK", source: "interactive", images: [{}] },
  ]) {
    assert.deepEqual(await mock.handlers.get("input")(input, mock.ctx), { action: "continue" })
    assert.deepEqual(latestState(mock).phases, prior)
    assert.equal(latestState(mock).stage, "awaiting_human_approval")
  }
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK if you skip all tests", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(latestState(mock).stage, "frontier_review", "conditional approval is revision feedback, not authority")
  assert.deepEqual(latestState(mock).phases, prior)
  assert.equal((await mock.tools.get("prewalk_checkpoint").execute("fresh-proposal", { action: "propose", kind: "plan", patch }, undefined, undefined, mock.ctx)).details.ok, true)
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(latestState(mock).stage, "awaiting_human_approval")
  assert.equal(mock.pi.currentModel.id, "frontier")
  assert.deepEqual(await mock.handlers.get("input")({ text: "NG", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(latestState(mock).stage, "awaiting_revision")
  assert.deepEqual(latestState(mock).phases, prior)
  assert.equal(latestState(mock).stopReason, null)
  assert.deepEqual(await mock.handlers.get("input")({ text: "Keep that check required", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(latestState(mock).stage, "frontier_review")
  const replacement = await mock.tools.get("prewalk_checkpoint").execute("replacement", { action: "propose", kind: "plan", patch: { ...patch, phases: prior } }, undefined, undefined, mock.ctx)
  assert.equal(replacement.details.ok, true)
  assert.notEqual(replacement.details.proposalId, proposal.details.proposalId)
  assert.deepEqual(await mock.handlers.get("input")({ text: "この計画で進めて", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(latestState(mock).stage, "frontier_review")
  assert.equal(latestState(mock).revisionConfirmationPending, true)
})

test("NG keeps Prewalk active, asks once, restores the conversation, and requires a revised plan", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal, plan } = await enterPlanProposal(mock, "機能を実装して")
  assert.match(mock.notices.at(-1).text, /OK.*NG/)
  const messages = mock.messages.length
  assert.deepEqual(await mock.handlers.get("input")({ text: "NG", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(latestState(mock).stage, "awaiting_revision")
  assert.equal(latestState(mock).stopReason, null)
  assert.equal(latestState(mock).proposals.find((item) => item.id === proposal.details.proposalId).status, "rejected")
  assert.match(mock.notices.at(-1).text, /変更したい点/)
  assert.equal(mock.messages.length, messages)
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).initialApproval, null)
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(latestState(mock).stage, "awaiting_revision")
  assert.match(mock.statuses.at(-1).text, /Awaiting feedback/)
  const result = await mock.handlers.get("input")({ text: "変更範囲をもっと小さくして", source: "interactive" }, mock.ctx)
  assert.deepEqual(result, { action: "continue" })
  assert.equal(latestState(mock).stage, "frontier_plan")
  const prompt = { prompt: "変更範囲をもっと小さくして", systemPromptOptions: { appendSystemPrompt: "" } }
  await mock.handlers.get("before_agent_start")(prompt, mock.ctx)
  assert.match(prompt.systemPromptOptions.appendSystemPrompt, /Japanese/)
  assert.match(prompt.systemPromptOptions.appendSystemPrompt, /変更範囲をもっと小さくして/)
  const revised = await mock.tools.get("prewalk_checkpoint").execute("revised", { action: "submit_plan", plan }, undefined, undefined, mock.ctx)
  assert.equal(revised.details.ok, true)
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).initialApproval.proposalId, revised.details.proposalId)
})

test("却下 rejects the displayed proposal without ending Prewalk", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal } = await enterPlanProposal(mock, "機能を実装して")
  assert.deepEqual(await mock.handlers.get("input")({ text: "却下", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(latestState(mock).stage, "awaiting_revision")
  assert.equal(latestState(mock).proposals.find((item) => item.id === proposal.details.proposalId).status, "rejected")
  assert.equal(latestState(mock).stopReason, null)
})

test("NG with feedback revises without asking again, and injected or conditional answers never approve", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "機能を実装して")
  for (const event of [
    { text: "NG", source: "extension" }, { text: "NG", source: "rpc" },
    { text: '引用: "NG"', source: "interactive" }, { text: "OK、ただしDBは触らないで", source: "interactive" },
  ]) {
    await mock.handlers.get("input")(event, mock.ctx)
    assert.equal(latestState(mock).stage, "awaiting_approval")
    assert.equal(latestState(mock).initialApproval, null)
  }
  const notices = mock.notices.length
  assert.deepEqual(await mock.handlers.get("input")({ text: "NG、テストを追加して", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(latestState(mock).stage, "frontier_plan")
  assert.match(latestState(mock).revisionRequest.feedback, /テストを追加して/)
  assert.equal(mock.notices.slice(notices).some(({ text }) => text.includes("変更したい点")), false)
})

test("NG on scope or final approval never terminates the run or applies the rejected proposal", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  for (const kind of ["hard", "final"]) {
    const mock = setup()
    extension(mock.pi)
    if (kind === "hard") {
      await enterFrontierReview(mock)
      await mock.tools.get("prewalk_checkpoint").execute("scope", { action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "docs/"] } }, undefined, undefined, mock.ctx)
    } else await enterFinalProposal(mock)
    await mock.handlers.get("input")({ text: "NG", source: "interactive" }, mock.ctx)
    assert.equal(latestState(mock).stage, "awaiting_revision")
    assert.equal(latestState(mock).revisionRequest.kind, kind)
    assert.deepEqual(latestState(mock).hardContract.allowedPaths, ["src/"])
    assert.notEqual(latestState(mock).stage, "complete")
    const feedback = "テストを追加する方針に修正して"
    await mock.handlers.get("input")({ text: feedback, source: "interactive" }, mock.ctx)
    assert.equal(latestState(mock).stage, "frontier_review")
    const context = await mock.handlers.get("context")({ messages: [{ role: "user", content: feedback }] }, mock.ctx)
    assert.ok(JSON.stringify(context).includes(feedback))
  }
})

test("ordinary scope and final revision feedback returns to review without an ID", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  for (const kind of ["hard", "final"]) {
    const mock = setup()
    extension(mock.pi)
    if (kind === "hard") {
      await enterFrontierReview(mock)
      await mock.tools.get("prewalk_checkpoint").execute("scope", { action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "docs/"] } }, undefined, undefined, mock.ctx)
    } else await enterFinalProposal(mock)
    assert.deepEqual(await mock.handlers.get("input")({ text: "変更範囲を修正して", source: "interactive" }, mock.ctx), { action: "continue" })
    assert.equal(latestState(mock).stage, "frontier_review")
    assert.deepEqual(latestState(mock).hardContract.allowedPaths, ["src/"])
  }
})

test("session language survives short prompts, revisions, and reload; explicit preference wins", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  for (const prompt of ["OK", "ls", "Implement the feature"]) {
    const mock = setup()
    mock.ctx.mode = "tui"; mock.ctx.hasUI = true
    mock.appended.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "計画について相談したいです" }] } })
    extension(mock.pi)
    const { plan } = await enterPlanProposal(mock, prompt)
    assert.equal(latestState(mock).displayLanguage, "ja")
    assert.match(mock.notices.at(-1).text, /目標:/)
    const revision = { prompt: "テストも追加して", systemPromptOptions: { appendSystemPrompt: "" } }
    await mock.handlers.get("before_agent_start")(revision, mock.ctx)
    assert.match(revision.systemPromptOptions.appendSystemPrompt, /Japanese/)
    await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
    assert.equal(latestState(mock).displayLanguage, "ja")
    const explicit = { prompt: "Please write the plan in English", systemPromptOptions: { appendSystemPrompt: "" } }
    await mock.handlers.get("before_agent_start")(explicit, mock.ctx)
    assert.match(explicit.systemPromptOptions.appendSystemPrompt, /English/)
    await mock.tools.get("prewalk_checkpoint").execute("english", { action: "submit_plan", plan }, undefined, undefined, mock.ctx)
    assert.match(mock.notices.at(-1).text, /Outcome:/)
  }
})

test("a paused restoration retries on direct input without resume or silently consuming approval", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "機能を実装して")
  mock.ctx.model = { provider: "mock", id: "cheap" }
  let attempts = 0
  mock.pi.setModel = async () => { attempts++; return false }
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  assert.equal(latestState(mock).stage, "paused")
  assert.match(mock.notices.at(-1).text, /モデル/)
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "handled" })
  assert.equal(attempts, 2)
  mock.pi.setModel = async (model) => { attempts++; mock.ctx.model = model; return true }
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).stage, "awaiting_approval")
  assert.equal(latestState(mock).initialApproval, null, "a newly redisplayed proposal needs a new reply")
  await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).stage, "frontier_initial")
})

test("substantive answers to decision questions return to review while OK and NG leave them unanswered", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock, "質問を確認して")
  await mock.tools.get("prewalk_checkpoint").execute("question", { action: "verdict", verdict: "needs-human", reason: "どの API を使いますか？" }, undefined, undefined, mock.ctx)
  for (const text of ["OK", "NG", "進めて"]) {
    await mock.handlers.get("input")({ text, source: "interactive" }, mock.ctx)
    assert.equal(latestState(mock).stage, "awaiting_human_approval")
  }
  assert.deepEqual(await mock.handlers.get("input")({ text: "既存の API を使ってください", source: "interactive" }, mock.ctx), { action: "continue" })
  assert.equal(latestState(mock).stage, "frontier_review")
  assert.ok(JSON.stringify(latestState(mock).important_decisions).includes("既存の API を使ってください"))
})

test("failed model selection retains NG feedback and retries without asking for it again", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "機能を実装して")
  mock.ctx.model = { provider: "mock", id: "cheap" }
  mock.pi.setModel = async () => false
  await mock.handlers.get("input")({ text: "NG、範囲を小さくして", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).stage, "awaiting_revision")
  assert.equal(latestState(mock).revisionRequest.feedback, "範囲を小さくして")
  mock.pi.setModel = async (model) => { mock.ctx.model = model; return true }
  const notices = mock.notices.length
  const result = await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).stage, "frontier_plan")
  assert.equal(latestState(mock).initialApproval, null)
  assert.equal(latestState(mock).revisionRequest.feedback, "範囲を小さくして")
  assert.deepEqual(result, { action: "transform", text: "範囲を小さくして" })
  assert.equal(mock.notices.slice(notices).some(({ text }) => text.includes("変更したい点")), false)
})

test("off while starting or arming never starts a run afterwards", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  const starting = mock.handlers.get("before_agent_start")({ prompt: "機能を実装して", systemPromptOptions: { appendSystemPrompt: "" } }, mock.ctx)
  await mock.commands.get("prewalk").handler("off", mock.ctx)
  await starting
  assert.ok(!latestState(mock) || latestState(mock).stage === "stopped")
  let release
  mock.ctx.model = { provider: "mock", id: "cheap" }
  mock.pi.setModel = (model) => model.id === "frontier" ? new Promise((resolve) => {
    release = () => { mock.ctx.model = model; resolve(true) }
  }) : Promise.resolve((mock.ctx.model = model, true))
  const arming = mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  while (!release) await Promise.resolve()
  const off = mock.commands.get("prewalk").handler("off", mock.ctx)
  release()
  await Promise.all([arming, off])
  assert.equal(mock.ctx.model.id, "cheap", "off must settle an in-flight host switch without leaving its target selected")
  await mock.commands.get("prewalk").handler("status", mock.ctx)
  assert.doesNotMatch(mock.notices.at(-1).text, /Armed/)
})

test("feedback supplied after bare NG is retained when model selection fails", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  await enterPlanProposal(mock, "機能を実装して")
  await mock.handlers.get("input")({ text: "NG", source: "interactive" }, mock.ctx)
  mock.ctx.model = { provider: "mock", id: "cheap" }
  mock.pi.setModel = async () => false
  await mock.handlers.get("input")({ text: "変更範囲を絞って", source: "interactive" }, mock.ctx)
  assert.equal(latestState(mock).stage, "awaiting_revision")
  assert.equal(latestState(mock).revisionRequest.feedback, "変更範囲を絞って")
  mock.pi.setModel = async (model) => { mock.ctx.model = model; return true }
  assert.deepEqual(await mock.handlers.get("input")({ text: "OK", source: "interactive" }, mock.ctx), { action: "transform", text: "変更範囲を絞って" })
})

test("a stale turn end cannot write usage or route a restored runtime", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  await enterFrontierReview(mock)
  let release, holding = true
  const append = mock.pi.appendEntry
  mock.pi.appendEntry = (type, data) => {
    append(type, data)
    if (holding && type === "prewalk-state") {
      holding = false
      return new Promise((resolve) => { release = resolve })
    }
  }
  const oldTurn = mock.handlers.get("turn_end")({ messageEntryId: "old", toolResultEntryIds: ["old-tool"], message: { role: "assistant", usage: { input: 99 } } }, mock.ctx)
  while (!release) await Promise.resolve()
  await mock.handlers.get("session_start")({ reason: "reload" }, mock.ctx)
  const state = latestState(mock), entryCount = mock.appended.length, messages = mock.messages.length
  release()
  await oldTurn
  assert.deepEqual(latestState(mock), state)
  assert.equal(mock.appended.length, entryCount)
  assert.equal(mock.messages.length, messages)
})

test("off preserves a user's model choice made while a host switch is settling", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  mock.ctx.model = { provider: "mock", id: "cheap" }
  let release
  mock.pi.setModel = async (model) => {
    if (model.id === "frontier") await new Promise((resolve) => { release = resolve })
    mock.ctx.model = model
    await mock.handlers.get("model_select")({ model, source: "set" }, mock.ctx)
    return true
  }
  const arming = mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  while (!release) await Promise.resolve()
  const off = mock.commands.get("prewalk").handler("off", mock.ctx)
  const manual = { provider: "mock", id: "manual" }
  const find = mock.ctx.modelRegistry.find
  mock.ctx.modelRegistry.find = (provider, id) => id === "manual" ? manual : find(provider, id)
  mock.ctx.model = manual
  await mock.handlers.get("model_select")({ model: mock.ctx.model, source: "cycle" }, mock.ctx)
  await release()
  await Promise.all([arming, off])
  assert.equal(mock.ctx.model.id, "manual")
})

test("off respects a manual selection of the pending target, including Pi's set source", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  for (const source of ["cycle", "set"]) {
    const mock = setup()
    extension(mock.pi)
    mock.ctx.model = { provider: "mock", id: "cheap" }
    let release
    mock.pi.setModel = async (model) => {
      if (model.id === "frontier" && !release) await new Promise((resolve) => { release = resolve })
      mock.ctx.model = model
      await mock.handlers.get("model_select")({ model, source: "set" }, mock.ctx)
      return true
    }
    const arming = mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
    while (!release) await Promise.resolve()
    const off = mock.commands.get("prewalk").handler("off", mock.ctx)
    mock.ctx.model = { provider: "mock", id: "frontier" }
    await mock.handlers.get("model_select")({ model: mock.ctx.model, source }, mock.ctx)
    release()
    await Promise.all([arming, off])
    assert.equal(mock.ctx.model.id, "frontier", source)
  }
})

test("off rechecks the latest human choice after its restoration switch settles", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  mock.ctx.model = { provider: "mock", id: "cheap" }
  const manual = { provider: "mock", id: "manual" }
  const find = mock.ctx.modelRegistry.find
  mock.ctx.modelRegistry.find = (provider, id) => id === "manual" ? manual : find(provider, id)
  let releaseInitial, releaseRestore
  const switches = []
  mock.pi.setModel = async (model) => {
    switches.push(model.id)
    if (model.id === "frontier") await new Promise((resolve) => { releaseInitial = resolve })
    if (model.id === "cheap") await new Promise((resolve) => { releaseRestore = resolve })
    mock.ctx.model = model
    await mock.handlers.get("model_select")({ model, source: "set" }, mock.ctx)
    return true
  }
  const arming = mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  while (!releaseInitial) await Promise.resolve()
  const off = mock.commands.get("prewalk").handler("off", mock.ctx)
  releaseInitial()
  while (!releaseRestore) await Promise.resolve()
  mock.ctx.model = manual
  await mock.handlers.get("model_select")({ model: manual, source: "set" }, mock.ctx)
  releaseRestore()
  await Promise.all([arming, off])
  assert.equal(mock.ctx.model.id, "manual")
  assert.deepEqual(switches, ["frontier", "cheap", "manual"])
})

test("off during model-select event delivery retains the choice from before the host assignment", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  extension(mock.pi)
  mock.ctx.model = { provider: "mock", id: "cheap" }
  let releaseEvent
  mock.pi.setModel = async (model) => {
    const previousModel = mock.ctx.model
    mock.ctx.model = model
    // Pi changes its model before awaiting extension model_select handlers.
    if (model.id === "frontier") await new Promise((resolve) => { releaseEvent = resolve })
    await mock.handlers.get("model_select")({ model, previousModel, source: "set" }, mock.ctx)
    return true
  }
  const arming = mock.commands.get("prewalk").handler("mock/frontier mock/cheap", mock.ctx)
  while (!releaseEvent) await Promise.resolve()
  assert.equal(mock.ctx.model.id, "frontier")
  const off = mock.commands.get("prewalk").handler("off", mock.ctx)
  releaseEvent()
  await Promise.all([arming, off])
  assert.equal(mock.ctx.model.id, "cheap")
})

test("assistant conversation language is a fallback, not an explicit user preference", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  mock.appended.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "この計画で進めますか？" }] } })
  extension(mock.pi)
  await enterPlanProposal(mock, "OK")
  assert.equal(latestState(mock).displayLanguage, "ja")
})

test("removed commands cannot mutate a pending or stopped run and are absent from guidance", async () => {
  const { default: extension } = await jiti.import(pathToFileURL(resolve(root, "extensions/pi-prewalk.ts")).href)
  const mock = setup()
  mock.ctx.mode = "tui"; mock.ctx.hasUI = true
  extension(mock.pi)
  const { proposal } = await enterPlanProposal(mock)
  for (const stopped of [false, true]) {
    if (stopped) await mock.commands.get("prewalk").handler("off", mock.ctx)
    const state = latestState(mock)
    for (const command of [`approve ${proposal.details.proposalId}`, `reject ${proposal.details.proposalId}`, "resume"]) {
      await mock.commands.get("prewalk").handler(command, mock.ctx)
      assert.match(mock.notices.at(-1).text, /Usage:/)
      assert.deepEqual(latestState(mock), state)
    }
  }
  assert.doesNotMatch(mock.tools.get("prewalk_checkpoint").description, /\/prewalk (approve|reject|resume)/)
  const source = readFileSync(join(root, "extensions/pi-prewalk.ts"), "utf8")
  assert.doesNotMatch(source, /\/prewalk (approve|reject|resume)|command === "(?:approve|reject|resume)"/)
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
