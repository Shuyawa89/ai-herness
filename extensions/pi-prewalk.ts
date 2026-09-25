import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Type } from "typebox"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parsePrewalkArgs, parsePrewalkConfig, PREWALK_PLAN_PATH, resolveRoutingConfig } from "./prewalk-core.mjs"
import { buildBoundedReviewMessages, createPrewalkRuntime } from "./prewalk-runtime.mjs"

const harnessRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))
const CONFIG_KEYS: Record<string, string> = {
  failure_threshold: "failureThreshold", tool_churn_threshold: "toolChurnThreshold", churn_window: "churnWindow",
  max_escalations: "maxEscalations", max_retries: "maxRetries", max_steps: "maxSteps",
  milestone_review: "milestoneReview", final_review: "finalReview", context_budget_chars: "contextBudgetChars",
  output_limit_chars: "outputLimitChars", command_timeout_ms: "commandTimeoutMs", scope_expansion_factor: "scopeExpansionFactor",
}

function getConfigSettings(settings: unknown) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Local Prewalk config must be a JSON object")
  const input = settings as Record<string, unknown>
  const routing: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const target = CONFIG_KEYS[key] ?? key
    if (target in resolveRoutingConfig()) routing[target] = value
  }
  return resolveRoutingConfig(routing)
}

function readLocalConfig() {
  const path = join(harnessRoot, "prewalk.json")
  if (!existsSync(path)) return undefined
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  return { models: parsePrewalkConfig(data), routing: getConfigSettings(data) }
}

function modelRef(model: { provider: string; id: string } | undefined) {
  return model ? `${model.provider}/${model.id}` : undefined
}
function resolveModel(ctx: ExtensionContext, value: string) {
  const [provider, ...parts] = value.split("/")
  return ctx.modelRegistry.find(provider, parts.join("/"))
}
function display(value: unknown) { return JSON.stringify(value, null, 2) }

function writePlanView(ctx: ExtensionContext, state: any) {
  if (!state?.plan) return
  const path = join(ctx.cwd, PREWALK_PLAN_PATH)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path) && !state.planWritten) {
    const backup = `${path}.prewalk-backup-${state.runId}`
    if (!existsSync(backup)) renameSync(path, backup)
  }
  const lines = ["# Prewalk accepted plan", "", `Run: ${state.runId}`, `Stage: ${state.stage}`, `Goal: ${state.goal}`, "", "## Hard contract", `- Outcome: ${state.hardContract?.outcome ?? ""}`]
  for (const item of state.hardContract?.constraints ?? []) lines.push(`- Constraint: ${item}`)
  lines.push("", "## Phases")
  for (const phase of state.phases ?? []) {
    lines.push(`### ${phase.id}`, "")
    for (const todo of phase.todos ?? []) lines.push(`- [${["ready", "completed"].includes(todo.status) ? "x" : " "}] ${todo.id}: ${todo.text ?? todo.title ?? todo.description ?? todo.id} (${todo.status})`)
    lines.push("")
  }
  lines.push("## Current state", "", `- Current step: ${state.current_step ?? "none"}`, `- Pending: ${(state.pending ?? []).join("; ") || "none"}`, `- Changed files: ${(state.changed_files ?? []).join(", ") || "none"}`)
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8")
}

export default function (pi: ExtensionAPI) {
  let latestCtx: ExtensionContext | undefined
  let switchingTo: string | undefined
  let armed: { frontierModel: string; cheapModel: string; routing: Record<string, unknown>; sessionId?: string } | undefined
  let handledCurrentTurn = false
  const createRuntime = () => createPrewalkRuntime({ deps: {
    cwd: process.cwd(),
    appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data),
    getBranch: () => latestCtx?.sessionManager.getBranch() ?? [],
    findModel: (ref: string) => latestCtx ? resolveModel(latestCtx, ref) : undefined,
    setModel: async (_model: unknown, ref: string) => latestCtx ? switchModel(ref, latestCtx) : false,
    sendMessage: (message: any) => {
      const content = routingPrompt(message)
      if (content === undefined || snapshotState()?.stage === "stopped") {
        latestCtx?.abort()
        notify(latestCtx, "Prewalk stopped: mandatory review context exceeds the budget", "error")
        return
      }
      pi.sendMessage({ customType: "prewalk-routing", content, display: true, details: { runId: message.state.runId, stage: message.state.stage, reason: message.reason } }, { deliverAs: "steer", triggerTurn: true })
    },
    notify: (message: string) => latestCtx?.ui.notify(message, "info"),
  } })
  let runtime = createRuntime()

  const notify = (ctx: ExtensionContext | undefined, text: string, kind: "info" | "warning" | "error" = "info") => ctx?.ui.notify(text, kind)
  const snapshotState = () => runtime.state()
  const persistView = (ctx: ExtensionContext | undefined) => { const state = snapshotState(); if (ctx && state) writePlanView(ctx, state) }

  async function switchModel(ref: string, ctx: ExtensionContext) {
    const target = resolveModel(ctx, ref)
    if (!target) return false
    switchingTo = ref
    try { return await pi.setModel(target) } finally { switchingTo = undefined }
  }

  function reviewEvidence(ctx: ExtensionContext) {
    const result = spawnSync("git", ["diff", "--no-ext-diff", "HEAD", "--"], { cwd: ctx.cwd, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 })
    return result.status === 0 ? result.stdout : `Diff unavailable; inspect the worktree directly (${result.error?.message ?? result.status}).`
  }

  function routingPrompt(message: any) {
    const state = message.state
    if (state.role === "frontier") {
      const evidence = runtime.reviewContext({ diff: latestCtx ? reviewEvidence(latestCtx) : "Diff unavailable" })
      if (!evidence.ok) return undefined
      return `PREWALK FRONTIER REVIEW\nReview phase(s): ${(state.reviewPhaseIds ?? []).join(", ") || "final/task"}. Review the actual diff and validation evidence before calling prewalk_checkpoint with a pass, repair, or needs-human verdict. Human approval cannot be issued by a model.\n${evidence.text}`
    }
    return `PREWALK CHEAP CONTINUATION\nContinue phase ${state.currentPhaseId ?? "current"} inside the approved hard contract. Repair pending work if applicable; do not broaden scope without a proposal.`
  }
  function reportSwitch(ctx: ExtensionContext, result: any) {
    if (result?.action === "stopped") notify(ctx, `Prewalk stopped: ${result.reason}`, "error")
    if (result?.action === "switched" && snapshotState()?.stage !== "stopped") notify(ctx, `Prewalk switched to ${result.model}`)
  }

  const checkpointSchema = Type.Object({
    action: Type.String(),
    eventId: Type.Optional(Type.String()),
    plan: Type.Optional(Type.Any()),
    phaseId: Type.Optional(Type.String()),
    todos: Type.Optional(Type.Array(Type.Object({ id: Type.String(), status: Type.String() }))),
    evidence: Type.Optional(Type.Array(Type.String())),
    currentStep: Type.Optional(Type.String()),
    pending: Type.Optional(Type.Array(Type.String())),
    decisions: Type.Optional(Type.Array(Type.String())),
    kind: Type.Optional(Type.String()),
    patch: Type.Optional(Type.Any()),
    sourceRevision: Type.Optional(Type.String()),
    verdict: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    pendingTodoIds: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false })
  pi.registerTool({
    name: "prewalk_checkpoint", label: "Prewalk checkpoint",
    description: "Submit an initial plan {hardContract:{outcome,constraints,allowedPaths,protectedPaths},softPlan:{expectedFiles},phases:[{id,todos:[{id,text,status}],checks:[{id,command,args,cwd,required}],evidenceRequired:[repoRelativeFilePath]}]}; report TODO progress and optional verified artifact paths via evidence; propose a refinement; or submit a Frontier verdict. Human approval is only through /prewalk approve.",
    parameters: checkpointSchema, executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const result = await runtime.checkpoint({ ...params, eventId: params.eventId ?? randomUUID() })
      persistView(ctx)
      return { content: [{ type: "text", text: display(result) }], details: result }
    },
  })
  pi.registerTool({
    name: "prewalk_validate", label: "Run planned check",
    description: "Optionally execute a validation check by its approved check ID and record the actual command exit status.",
    parameters: Type.Object({ checkId: Type.String() }, { additionalProperties: false }), executionMode: "sequential",
    async execute(id, params) {
      const result = await runtime.validate(params.checkId, { toolCallId: id })
      return { content: [{ type: "text", text: display(result) }], details: result }
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx
    armed = undefined
    runtime = createRuntime()
    const restored = await runtime.restore({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd })
    if (restored.ok && !restored.terminal) notify(ctx, "Prewalk state restored paused; use /prewalk resume to continue.", "warning")
  })
  pi.on("session_tree", async (_event, ctx) => {
    latestCtx = ctx
    armed = undefined
    runtime = createRuntime()
    const restored = await runtime.restore({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd })
    if (restored.ok && !restored.terminal) notify(ctx, "Prewalk branch state restored paused; use /prewalk resume to continue.", "warning")
  })

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx
    if (armed && !runtime.state() && event.prompt.trim()) {
      const sessionId = ctx.sessionManager.getSessionId()
      if (armed.sessionId && armed.sessionId !== sessionId) { armed = undefined; return }
      const started = await runtime.start({ runId: randomUUID(), sessionId, workspace: ctx.cwd, goal: event.prompt, frontierModel: armed.frontierModel, cheapModel: armed.cheapModel })
      if (!started.ok) { notify(ctx, `Prewalk could not start: ${started.reason}`, "error"); return }
      const planPath = join(ctx.cwd, PREWALK_PLAN_PATH)
      if (existsSync(planPath)) renameSync(planPath, `${planPath}.prewalk-backup-${started.state.runId}`)
      armed.sessionId = sessionId
    }
    const state = snapshotState()
    if (state && !["stopped", "complete", "paused"].includes(state.stage)) {
      const stageGuidance = state.stage === "frontier_plan"
        ? "Discover repository-specific checks from instructions, CI, build files, and tests. Write the human plan, then submit a structured plan with prewalk_checkpoint action submit_plan. Shape: {hardContract:{outcome:string,constraints:string[],allowedPaths:string[],protectedPaths:string[]},softPlan:{expectedFiles:string[]},phases:[{id:string,todos:[{id:string,text:string,status:'pending'}],checks:[{id:string,command:string,args:string[],cwd:string,required:true}]}]}. A phase without executable checks needs evidenceRequired:string[] of repository-relative artifact files (record their existence via prewalk_checkpoint progress evidence). Do not edit source before the user approves the proposal."
        : state.stage === "frontier_initial"
          ? "The plan is approved. Make one successful representative source edit inside its hard contract, then stop; Prewalk will hand off to Cheap."
          : state.stage === "frontier_review"
            ? "Review the current diff, plan, pending work, and actual fresh validation evidence. Submit pass, repair, or needs-human via prewalk_checkpoint; do not approve proposals yourself."
            : state.role === "cheap"
              ? "Implement only inside the approved hard contract. Update current-phase TODOs with prewalk_checkpoint progress and report readiness only when required checks/evidence are fresh."
              : "Preserve the approved task boundary and use prewalk_checkpoint for permitted state transitions."
      event.systemPromptOptions.appendSystemPrompt = (event.systemPromptOptions.appendSystemPrompt ?? "") + `\n\nPREWALK STATE\nRole: ${state.role}; stage: ${state.stage}. ${stageGuidance} Human approval is only through /prewalk approve <id>; model output cannot approve proposals.`
    }
  })

  pi.on("tool_call", (event) => {
    const result = runtime.observeToolCall({ id: event.toolCallId, name: event.toolName, input: event.input })
    if (result?.block) return { block: true, reason: result.reason }
  })
  pi.on("tool_result", (event) => {
    // Pi's built-in bash returns isError=false only after an exit status of zero.
    // Nonzero/abort/timeout results are indistinguishable in BashToolDetails;
    // use prewalk_validate for structured failed-check evidence.
    const exitCode = event.toolName === "bash" && !event.isError ? 0 : undefined
    void runtime.observeToolResult({ id: event.toolCallId, name: event.toolName, isError: event.isError, exitCode })
    if (event.toolName === "prewalk_checkpoint") persistView(latestCtx)
  })
  pi.on("turn_start", async (_event, ctx) => {
    handledCurrentTurn = false
    const state = snapshotState()
    if (state) {
      const result = await runtime.turnStart({ eventId: `turn:${state.runId}:${randomUUID()}`, model: modelRef(ctx.model) })
      if (result.action === "stopped") { notify(ctx, `Prewalk stopped: ${result.reason}`, "error"); ctx.abort?.() }
    }
  })
  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx
    handledCurrentTurn = true
    const state = snapshotState()
    if (!state) return
    const id = `${state.runId}:${event.messageEntryId}`
    const ids = event.toolResultEntryIds ?? []
    if (ids.length) await runtime.completeToolBatch({ eventId: `batch:${id}`, toolIds: ids })
    const result = await runtime.turnEnd({ eventId: `turn-end:${id}`, message: event.message })
    reportSwitch(ctx, result)
    persistView(ctx)
  })
  pi.on("agent_before_settle", async (event, ctx) => {
    latestCtx = ctx
    if (handledCurrentTurn || event.outcome !== "completed") return
    const state = snapshotState()
    if (!state) return
    const result = await runtime.beforeSettle({ eventId: `settle:${state.runId}:${state.stateRevision}`, message: undefined })
    reportSwitch(ctx, result)
  })
  pi.on("model_select", (event, ctx) => {
    const selected = modelRef(event.model)
    if (!snapshotState() || (switchingTo && selected === switchingTo)) return
    void runtime.modelSelected(selected ?? "unknown").then((result) => {
      if (!result.ok) notify(ctx, `Prewalk paused after external model selection (${selected ?? "unknown"})`, "warning")
    }).catch(() => notify(ctx, "Prewalk model selection could not be recorded", "error"))
  })
  pi.on("context", async (event, ctx) => {
    const state = snapshotState()
    if (!state || ["paused", "stopped", "complete"].includes(state.stage)) return
    if (state.stage === "frontier_review") {
      const prompt = routingPrompt({ state })
      if (prompt === undefined || snapshotState()?.stage === "stopped") {
        ctx.abort()
        notify(ctx, "Prewalk stopped: mandatory review context exceeds the budget", "error")
        return
      }
      const reviewMessage = { role: "custom" as const, customType: "prewalk-current-state", display: false, timestamp: Date.now(), content: prompt }
      const available = state.config.contextBudgetChars - JSON.stringify(reviewMessage).length
      const bounded = available > 0 ? buildBoundedReviewMessages(event.messages, available) : { ok: false, messages: [] }
      if (!bounded.ok) {
        ctx.abort()
        await runtime.pause("mandatory-context-exceeds-budget")
        notify(ctx, "Prewalk stopped: mandatory review context exceeds the budget", "error")
        return
      }
      return { messages: [...bounded.messages, reviewMessage] }
    }
    return { messages: [...event.messages, { role: "custom", customType: "prewalk-current-stage", display: false, timestamp: Date.now(), content: `Prewalk role: ${state.role}; stage: ${state.stage}; phase: ${state.currentPhaseId ?? "none"}. ${state.role === "cheap" ? "Stay inside the approved hard boundary; report phase TODOs and observed checks, then wait for Frontier review." : "Inspect plan, changed paths and evidence; record your review verdict or an exact proposal."} Only /prewalk approve can approve the hard contract or task completion.` }] }
  })

  pi.registerCommand("prewalk", {
    description: "Arm, inspect, approve, resume, or disable bidirectional Prewalk routing.",
    handler: async (args, ctx) => {
      latestCtx = ctx
      const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      if (command === "off") {
        armed = undefined
        await runtime.cancel()
        ctx.ui.notify("Prewalk routing disabled", "info")
        return
      }
      if (command === "status") {
        const state = snapshotState()
        if (!state) { ctx.ui.notify(armed ? `Armed for next user prompt: ${armed.frontierModel} -> ${armed.cheapModel}` : "Prewalk idle", "info"); return }
        const proposal = state.proposals?.find((item: any) => item.status === "pending")
        ctx.ui.notify(`${display(runtime.status())}\n\n${proposal ? `Pending proposal (approval required):\n${display(proposal)}` : `Plan:\n${display(state.plan ?? state.goal)}`}`, "info")
        return
      }
      if (command === "approve") {
        const proposalId = rest[0]
        if (!proposalId) { ctx.ui.notify("Usage: /prewalk approve <proposal-id>", "error"); return }
        const state = snapshotState()
        const proposal = state?.proposals?.find((item: any) => item.id === proposalId && item.status === "pending")
        if (!proposal) { ctx.ui.notify("No matching pending proposal. Run /prewalk status and approve only the displayed ID.", "error"); return }
        ctx.ui.notify(`Approval target:\n${display(proposal)}`, "info")
        if (!await ctx.ui.confirm("Approve Prewalk proposal?", display(proposal))) return
        const result = await runtime.approve(proposalId, { baseRevision: proposal.baseRevision })
        persistView(ctx)
        if (!result.ok) { ctx.ui.notify(`Approval refused: ${result.reason}`, "error"); return }
        const approvedState = snapshotState()
        if (approvedState && ["frontier_initial", "cheap_pending", "cheap", "frontier_review"].includes(approvedState.stage)) {
          // Approval made while idle may restart the user turn, but does not authorize any other proposal.
          pi.sendUserMessage("Continue the approved Prewalk task in this session.", { deliverAs: "followUp" })
        }
        ctx.ui.notify(`Approved ${proposalId}`, "info")
        return
      }
      if (command === "reject") {
        const proposalId = rest[0]
        const state = snapshotState()
        const proposal = state?.proposals?.find((item: any) => item.id === proposalId && item.status === "pending")
        if (!proposal) { ctx.ui.notify("No matching pending proposal to reject.", "error"); return }
        ctx.ui.notify(`Rejection target:\n${display(proposal)}`, "warning")
        if (!await ctx.ui.confirm("Reject this Prewalk proposal?", display(proposal))) return
        const result = await runtime.rejectProposal(proposalId)
        if (result.action !== "stopped") ctx.ui.notify(`Could not reject proposal: ${result.reason}`, "error")
        else ctx.ui.notify(`Rejected ${proposalId}; task is stopped and will not continue automatically.`, "warning")
        return
      }
      if (command === "resume") {
        const result = await runtime.resume()
        if (!result.ok) { ctx.ui.notify(`Cannot resume: ${result.reason}`, "error"); return }
        pi.sendUserMessage("Resume the explicitly paused Prewalk task.", { deliverAs: "followUp" })
        return
      }
      try {
        if (["stopped", "complete"].includes(snapshotState()?.stage ?? "")) runtime = createRuntime()
        let models: { firstModel: string; secondModel: string }
        let routing: Record<string, unknown>
        const explicitCount = args.trim() ? args.trim().split(/\s+/).length : 0
        if (explicitCount === 2) {
          models = parsePrewalkArgs(args)
          // Fully explicit model IDs intentionally bypass malformed local config.
          routing = getConfigSettings({})
        } else {
          const local = readLocalConfig()
          models = parsePrewalkArgs(args, local?.models)
          routing = local?.routing ?? getConfigSettings({})
        }
        const frontier = resolveModel(ctx, models.firstModel)
        const cheap = resolveModel(ctx, models.secondModel)
        if (!frontier || !cheap) throw new Error(`Model unavailable: ${!frontier ? models.firstModel : models.secondModel}`)
        await runtime.configure(routing)
        const selected = modelRef(ctx.model)
        if (selected !== models.firstModel && !await switchModel(models.firstModel, ctx)) throw new Error(`Could not select Frontier model ${models.firstModel}`)
        armed = { frontierModel: models.firstModel, cheapModel: models.secondModel, routing: { ...routing } }
        ctx.ui.notify(`Prewalk armed for the next user prompt: ${models.firstModel} -> ${models.secondModel}. Submit the task prompt next.`, "info")
      } catch (error) {
        ctx.ui.notify(`Prewalk: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    },
  })
}
