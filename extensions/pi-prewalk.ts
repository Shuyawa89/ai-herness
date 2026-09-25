import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
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
function languageForGoal(goal: string) {
  if (/\b(?:in|write|respond in) English\b/i.test(goal) || /英語で/.test(goal)) return "en"
  if (/\b(?:in|write|respond in) Japanese\b/i.test(goal) || /日本語で/.test(goal)) return "ja"
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(goal) ? "ja" : "en"
}
function planLanguage(state: any) { return state.displayLanguage ?? languageForGoal(state.goal ?? "") }
function label(state: any, english: string, japanese: string) { return planLanguage(state) === "ja" ? japanese : english }
function pendingProposal(state: any) {
  if (!state || !["awaiting_approval", "awaiting_human_approval", "awaiting_final_approval"].includes(state.stage)) return undefined
  const pending = state.proposals?.filter((proposal: any) => proposal.status === "pending") ?? []
  return pending.length === 1 ? pending[0] : undefined
}
function contractSummary(state: any, contract: any) {
  const lines = [`${label(state, "Outcome", "目標")}: ${contract.outcome ?? ""}`]
  const list = (heading: string, items: string[]) => {
    lines.push(`${heading}: ${items.length ? items.join(", ") : label(state, "none", "なし")}`)
  }
  list(label(state, "Constraints", "制約"), contract.constraints ?? [])
  list(label(state, "Allowed paths", "変更可能なパス"), contract.allowedPaths ?? [])
  list(label(state, "Protected paths", "保護するパス"), contract.protectedPaths ?? [])
  return lines
}
function planSummary(state: any, plan: any) {
  const lines = contractSummary(state, plan.hardContract ?? {})
  lines.push(`${label(state, "Expected files", "想定ファイル")}: ${(plan.softPlan?.expectedFiles ?? []).join(", ") || label(state, "none", "なし")}`)
  lines.push(label(state, "Phases", "フェーズ") + ":")
  for (const phase of plan.phases ?? []) {
    lines.push(`  ${phase.id}: ${(phase.todos ?? []).map((todo: any) => todo.text ?? todo.title ?? todo.id).join("; ")}`)
    for (const check of phase.checks ?? []) {
      lines.push(`    ${label(state, "Check", "検証")}: ${typeof check === "string" ? check : [check.command, ...(check.args ?? [])].join(" ")}`)
    }
    for (const file of phase.evidenceRequired ?? []) lines.push(`    ${label(state, "Evidence", "確認する成果物")}: ${file}`)
  }
  return lines
}
function approvalText(state: any, proposal: any) {
  const kind = { initial: label(state, "initial plan", "初回計画"), hard: label(state, "scope change", "作業範囲の変更"), final: label(state, "task completion", "最終完了"), decision: label(state, "human decision", "人間の判断が必要な質問") }[proposal.kind as "initial" | "hard" | "final" | "decision"] ?? proposal.kind
  const detail = proposal.kind === "hard"
    ? `${label(state, "Current boundary", "現在の作業範囲")}:\n${contractSummary(state, state.hardContract).join("\n")}\n${label(state, "Boundary after change", "変更後の作業範囲")}:\n${contractSummary(state, { ...state.hardContract, ...proposal.patch }).join("\n")}`
    : proposal.kind === "final"
      ? `${label(state, "Goal", "目的")}: ${state.goal}\n${label(state, "Changed files", "変更ファイル")}: ${display(state.changed_files)}\n${label(state, "Completed phases", "完了したフェーズ")}: ${display(state.completed)}\n${label(state, "Validation results", "検証結果")}: ${display(state.validation_results)}\n${label(state, "Pending work", "未完了の作業")}: ${display(state.pending)}`
      : proposal.kind === "initial" ? planSummary(state, proposal.patch).join("\n") : display(proposal.patch)
  const response = proposal.kind === "decision"
    ? label(state, "Answer the question; a generic approval is not a decision.", "質問に回答してください。単なる承認では判断できません。")
    : label(state, "Reply OK to approve this exact proposal, or use /prewalk status to inspect it.", "内容を確認して OK などで承認できます。/prewalk status でも確認できます。")
  return `Prewalk — ${kind}\n${detail}\n${response}`
}

function statusLine(ctx: ExtensionContext, state: any, armed: { frontierModel: string; cheapModel: string } | undefined) {
  const names = state ?? armed
  if (!names) return undefined
  const stages = ["Plan", "First edit", "Build", "Review", "Done"]
  const current = state?.stage === "frontier_plan" ? "Plan"
    : state?.stage === "frontier_initial" ? "First edit"
      : ["cheap", "cheap_pending"].includes(state?.stage) ? "Build"
        : ["frontier_review", "frontier_review_pending"].includes(state?.stage) ? "Review"
          : state?.stage === "complete" ? "Done" : undefined
  const number = (state?.phases ?? []).findIndex((phase: any) => phase.id === state?.currentPhaseId) + 1
  const steps = stages.map((step) => {
    const text = step === "Build" && number > 0 ? `Build (${number}/${state.phases.length})` : step
    return step === current ? ctx.ui.theme?.fg("accent", ctx.ui.theme.bold(text)) ?? text : ctx.ui.theme?.fg("dim", text) ?? text
  })
  const waiting = state?.stage === "awaiting_approval" ? "plan"
    : state?.stage === "awaiting_final_approval" ? "final"
      : state?.stage === "awaiting_human_approval" ? "scope" : undefined
  const special = pendingProposal(state)?.kind === "decision" ? "Awaiting decision"
    : waiting ? `Awaiting approval (${waiting})`
      : state?.stage === "paused" ? "Paused" : state?.stage === "stopped" ? "Stopped"
      : !state ? "Armed" : undefined
  const focus = special ?? (current === "Build" && number > 0 ? `Build (${number}/${state.phases.length})` : current ?? "Idle")
  const highlighted = ctx.ui.theme?.fg("accent", ctx.ui.theme.bold(focus)) ?? focus
  const role = waiting || ["paused", "stopped", "complete"].includes(state?.stage) ? undefined : state?.role
  const frontier = `${role === "frontier" ? ">" : ""}F:${names.frontierModel}`
  const cheap = `${role === "cheap" ? ">" : ""}C:${names.cheapModel}`
  return `Prewalk: ${highlighted} | ${steps.join(" → ")} | ${frontier} ${cheap}`
}

function writePlanView(ctx: ExtensionContext, state: any) {
  if (!state?.plan) return
  const path = join(ctx.cwd, PREWALK_PLAN_PATH)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path) && !state.planWritten) {
    const backup = `${path}.prewalk-backup-${state.runId}`
    if (!existsSync(backup)) renameSync(path, backup)
  }
  const lines = [label(state, "# Prewalk accepted plan", "# Prewalk の承認済み計画"), "", `${label(state, "Run", "実行ID")}: ${state.runId}`, `${label(state, "Stage", "状態")}: ${state.stage}`, `${label(state, "Goal", "目的")}: ${state.goal}`, "", label(state, "## Hard contract", "## 承認済みの作業範囲"), `- ${label(state, "Outcome", "目標")}: ${state.hardContract?.outcome ?? ""}`]
  for (const item of state.hardContract?.constraints ?? []) lines.push(`- ${label(state, "Constraint", "制約")}: ${item}`)
  lines.push(`- ${label(state, "Allowed paths", "変更可能なパス")}: ${(state.hardContract?.allowedPaths ?? []).join(", ") || label(state, "none", "なし")}`)
  lines.push(`- ${label(state, "Protected paths", "保護するパス")}: ${(state.hardContract?.protectedPaths ?? []).join(", ") || label(state, "none", "なし")}`)
  lines.push("", label(state, "## Phases", "## フェーズ"))
  for (const phase of state.phases ?? []) {
    lines.push(`### ${phase.id}`, "")
    for (const todo of phase.todos ?? []) lines.push(`- [${["ready", "completed"].includes(todo.status) ? "x" : " "}] ${todo.id}: ${todo.text ?? todo.title ?? todo.description ?? todo.id} (${todo.status})`)
    for (const check of phase.checks ?? []) lines.push(`- ${label(state, "Check", "検証")}: ${typeof check === "string" ? check : [check.command, ...(check.args ?? [])].join(" ")}`)
    for (const file of phase.evidenceRequired ?? []) lines.push(`- ${label(state, "Evidence", "確認する成果物")}: ${file}`)
    lines.push("")
  }
  lines.push(label(state, "## Current state", "## 現在の状態"), "", `- ${label(state, "Current step", "現在の作業")}: ${state.current_step ?? label(state, "none", "なし")}`, `- ${label(state, "Pending", "未完了")}: ${(state.pending ?? []).join("; ") || label(state, "none", "なし")}`, `- ${label(state, "Changed files", "変更ファイル")}: ${(state.changed_files ?? []).join(", ") || label(state, "none", "なし")}`)
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8")
}

export default function (pi: ExtensionAPI) {
  let latestCtx: ExtensionContext | undefined
  let switchingTo: string | undefined
  let armed: { frontierModel: string; cheapModel: string; routing: Record<string, unknown>; sessionId?: string } | undefined
  let handledCurrentTurn = false
  let shownProposal: { runId: string; sessionId: string; workspace: string; id: string; baseRevision: string; hardRevision: number } | undefined
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
  const updateStatus = (ctx: ExtensionContext | undefined) => {
    if (ctx) ctx.ui.setStatus("prewalk", statusLine(ctx, snapshotState(), armed))
  }
  const persistView = (ctx: ExtensionContext | undefined) => {
    const state = snapshotState()
    if (ctx && state) writePlanView(ctx, state)
    updateStatus(ctx)
  }
  const presentPending = (ctx: ExtensionContext | undefined) => {
    const state = snapshotState()
    const proposal = pendingProposal(state)
    if (!ctx?.hasUI || !proposal) return
    const target = { runId: state.runId, sessionId: state.sessionId, workspace: state.workspace, id: proposal.id, baseRevision: proposal.baseRevision, hardRevision: proposal.hardRevision }
    if (shownProposal && Object.keys(target).every((key) => (shownProposal as any)[key] === (target as any)[key])) return
    shownProposal = target
    ctx.ui.notify(approvalText(state, proposal), "info")
  }

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
      presentPending(ctx)
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
    shownProposal = undefined
    runtime = createRuntime()
    const restored = await runtime.restore({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd })
    updateStatus(ctx)
    if (restored.ok && !restored.terminal) notify(ctx, "Prewalk state restored paused; use /prewalk resume to continue.", "warning")
  })
  pi.on("session_tree", async (_event, ctx) => {
    latestCtx = ctx
    armed = undefined
    shownProposal = undefined
    runtime = createRuntime()
    const restored = await runtime.restore({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd })
    updateStatus(ctx)
    if (restored.ok && !restored.terminal) notify(ctx, "Prewalk branch state restored paused; use /prewalk resume to continue.", "warning")
  })

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx
    if (armed && !runtime.state() && event.prompt.trim()) {
      const sessionId = ctx.sessionManager.getSessionId()
      if (armed.sessionId && armed.sessionId !== sessionId) { armed = undefined; return }
      const started = await runtime.start({ runId: randomUUID(), sessionId, workspace: ctx.cwd, goal: event.prompt, displayLanguage: languageForGoal(event.prompt), frontierModel: armed.frontierModel, cheapModel: armed.cheapModel })
      if (!started.ok) { notify(ctx, `Prewalk could not start: ${started.reason}`, "error"); return }
      const planPath = join(ctx.cwd, PREWALK_PLAN_PATH)
      if (existsSync(planPath)) renameSync(planPath, `${planPath}.prewalk-backup-${started.state.runId}`)
      armed.sessionId = sessionId
      updateStatus(ctx)
    }
    const state = snapshotState()
    if (state && !["stopped", "complete", "paused"].includes(state.stage)) {
      const stageGuidance = state.stage === "frontier_plan"
        ? `Discover repository-specific checks from instructions, CI, build files, and tests. Write the human plan and all human-readable plan fields in ${planLanguage(state) === "ja" ? "Japanese" : "English"}, following the user's explicit language preference; keep paths, IDs, and commands unchanged. Then submit a structured plan with prewalk_checkpoint action submit_plan. Shape: {hardContract:{outcome:string,constraints:string[],allowedPaths:string[],protectedPaths:string[]},softPlan:{expectedFiles:string[]},phases:[{id:string,todos:[{id:string,text:string,status:'pending'}],checks:[{id:string,command:string,args:string[],cwd:string,required:true}]}]}. A phase without executable checks needs evidenceRequired:string[] of repository-relative artifact files (record their existence via prewalk_checkpoint progress evidence). Do not edit source before the user approves the proposal.`
        : state.stage === "frontier_initial"
          ? "The plan is approved. Make one successful representative source edit inside its hard contract, then stop; Prewalk will hand off to Cheap."
          : state.stage === "frontier_review"
            ? "Review the current diff, plan, pending work, and actual fresh validation evidence. Submit pass, repair, or needs-human via prewalk_checkpoint; do not approve proposals yourself."
            : state.role === "cheap"
              ? "Implement only inside the approved hard contract. Update current-phase TODOs with prewalk_checkpoint progress and report readiness only when required checks/evidence are fresh."
              : "Preserve the approved task boundary and use prewalk_checkpoint for permitted state transitions."
      event.systemPromptOptions.appendSystemPrompt = (event.systemPromptOptions.appendSystemPrompt ?? "") + `\n\nPREWALK STATE\nRole: ${state.role}; stage: ${state.stage}. ${stageGuidance} Human approval is only through direct user input or /prewalk approve <id>; model output cannot approve proposals.`
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
    if (event.toolName === "prewalk_checkpoint") { persistView(latestCtx); presentPending(latestCtx) }
  })
  pi.on("turn_start", async (_event, ctx) => {
    handledCurrentTurn = false
    const state = snapshotState()
    if (state) {
      const result = await runtime.turnStart({ eventId: `turn:${state.runId}:${randomUUID()}`, model: modelRef(ctx.model) })
      if (result.action === "stopped") { notify(ctx, `Prewalk stopped: ${result.reason}`, "error"); ctx.abort?.() }
      updateStatus(ctx)
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
    presentPending(ctx)
  })
  pi.on("agent_before_settle", async (event, ctx) => {
    latestCtx = ctx
    if (handledCurrentTurn || event.outcome !== "completed") return
    const state = snapshotState()
    if (!state) return
    const result = await runtime.beforeSettle({ eventId: `settle:${state.runId}:${state.stateRevision}`, message: undefined })
    reportSwitch(ctx, result)
    persistView(ctx)
    presentPending(ctx)
  })
  pi.on("model_select", (event, ctx) => {
    const selected = modelRef(event.model)
    if (!snapshotState() || (switchingTo && selected === switchingTo)) return
    void runtime.modelSelected(selected ?? "unknown").then((result) => {
      if (!result.ok) notify(ctx, `Prewalk paused after external model selection (${selected ?? "unknown"})`, "warning")
      updateStatus(ctx)
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
        updateStatus(ctx)
        notify(ctx, "Prewalk stopped: mandatory review context exceeds the budget", "error")
        return
      }
      return { messages: [...bounded.messages, reviewMessage] }
    }
    return { messages: [...event.messages, { role: "custom", customType: "prewalk-current-stage", display: false, timestamp: Date.now(), content: `Prewalk role: ${state.role}; stage: ${state.stage}; phase: ${state.currentPhaseId ?? "none"}. ${state.role === "cheap" ? "Stay inside the approved hard boundary; report phase TODOs and observed checks, then wait for Frontier review." : "Inspect plan, changed paths and evidence; record your review verdict or an exact proposal."} Only direct user input or /prewalk approve can approve the hard contract or task completion.` }] }
  })

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || ctx.mode !== "tui" || !ctx.hasUI || event.images?.length) return { action: "continue" }
    const state = snapshotState()
    const proposal = pendingProposal(state)
    if (!proposal) return { action: "continue" }
    const answer = event.text.trim().toLocaleLowerCase("en")
    const common = ["承認", "ok", "いいよ"]
    const extra = proposal.kind === "initial" ? ["進めて", "この計画で進めて"]
      : proposal.kind === "hard" ? ["この変更で進めて"]
        : proposal.kind === "final" ? ["完了を承認"] : []
    if (![...common, ...extra].includes(answer)) return { action: "continue" }
    if (proposal.kind === "decision") {
      notify(ctx, approvalText(state, proposal), "warning")
      return { action: "handled" }
    }
    const displayed = shownProposal
    if (!displayed || displayed.runId !== state.runId || displayed.sessionId !== ctx.sessionManager.getSessionId() ||
      displayed.workspace !== resolve(ctx.cwd) || displayed.id !== proposal.id || displayed.baseRevision !== proposal.baseRevision ||
      displayed.hardRevision !== proposal.hardRevision || state.sessionId !== ctx.sessionManager.getSessionId() || state.workspace !== resolve(ctx.cwd)) {
      shownProposal = undefined
      presentPending(ctx)
      notify(ctx, label(state, "Approval target changed. Review the proposal before replying again.", "承認対象が変更されました。内容を再確認してから返信してください。"), "warning")
      return { action: "handled" }
    }
    shownProposal = undefined
    const result = await runtime.approve(proposal.id, { baseRevision: proposal.baseRevision })
    persistView(ctx)
    if (!result.ok) {
      notify(ctx, `${label(state, "Approval refused", "承認できません")}: ${result.reason}`, "error")
      return { action: "handled" }
    }
    const approved = snapshotState()
    if (approved && ["frontier_initial", "cheap_pending", "cheap", "frontier_review"].includes(approved.stage)) {
      pi.sendUserMessage("Continue the approved Prewalk task in this session.", { deliverAs: "followUp" })
    }
    notify(ctx, label(state, "Proposal approved", "提案を承認しました"))
    return { action: "handled" }
  })

  pi.registerCommand("prewalk", {
    description: "Arm, inspect, approve, resume, or disable bidirectional Prewalk routing.",
    handler: async (args, ctx) => {
      latestCtx = ctx
      const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      if (command === "off") {
        armed = undefined
        shownProposal = undefined
        await runtime.cancel()
        ctx.ui.setStatus("prewalk", undefined)
        ctx.ui.notify("Prewalk routing disabled", "info")
        return
      }
      if (command === "status") {
        const state = snapshotState()
        if (!state) { ctx.ui.notify(armed ? `Armed for next user prompt: ${armed.frontierModel} -> ${armed.cheapModel}` : "Prewalk idle", "info"); return }
        const proposal = pendingProposal(state)
        ctx.ui.notify(`${display({ ...runtime.status(), frontierModel: state.frontierModel, cheapModel: state.cheapModel })}\n\n${proposal ? approvalText(state, proposal) : `${label(state, "Plan", "計画")}:\n${state.plan ? planSummary(state, state.plan).join("\n") : state.goal}`}`, "info")
        if (proposal) presentPending(ctx)
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
        shownProposal = undefined
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
        shownProposal = undefined
        updateStatus(ctx)
        if (result.action !== "stopped") ctx.ui.notify(`Could not reject proposal: ${result.reason}`, "error")
        else ctx.ui.notify(`Rejected ${proposalId}; task is stopped and will not continue automatically.`, "warning")
        return
      }
      if (command === "resume") {
        const result = await runtime.resume()
        if (!result.ok) { ctx.ui.notify(`Cannot resume: ${result.reason}`, "error"); return }
        persistView(ctx)
        presentPending(ctx)
        pi.sendUserMessage("Resume the explicitly paused Prewalk task.", { deliverAs: "followUp" })
        return
      }
      try {
        if (["stopped", "complete"].includes(snapshotState()?.stage ?? "")) { runtime = createRuntime(); shownProposal = undefined }
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
        updateStatus(ctx)
        ctx.ui.notify(`Prewalk armed for the next user prompt: ${models.firstModel} -> ${models.secondModel}. Submit the task prompt next.`, "info")
      } catch (error) {
        ctx.ui.notify(`Prewalk: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    },
  })
}
