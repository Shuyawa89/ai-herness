import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
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
const COMMON_APPROVALS = new Set(["承認", "ok", "いいよ"])
const PROPOSAL_APPROVALS: Record<string, Set<string>> = {
  initial: new Set(["進めて", "この計画で進めて"]),
  hard: new Set(["この変更で進めて"]),
  plan: new Set(["この計画で進めて"]),
  final: new Set(["完了を承認"]),
}
const SHORT_ANSWERS = new Set(["ng", "却下", ...COMMON_APPROVALS, ...Object.values(PROPOSAL_APPROVALS).flatMap((replies) => [...replies])])

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
function explicitLanguage(text: string) {
  if (/\b(?:in|write|respond in) English\b/i.test(text) || /英語で/.test(text)) return "en"
  if (/\b(?:in|write|respond in) Japanese\b/i.test(text) || /日本語で/.test(text)) return "ja"
  return undefined
}
function textLanguage(text: string) {
  if (/^(?:ok|ng|\/\S+)$/i.test(text.trim())) return undefined
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja"
  return (text.match(/[a-z]+/gi)?.length ?? 0) >= 3 ? "en" : undefined
}
function sessionLanguage(ctx: ExtensionContext, prompt: string) {
  const history = ctx.sessionManager.getBranch().flatMap((entry: any) => {
    if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) return []
    const content = entry.message.content
    const text = typeof content === "string" ? content : (content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    return text === prompt ? [] : [{ role: entry.message.role, text }]
  }).reverse()
  const userTexts = history.filter((item) => item.role === "user").map((item) => item.text)
  return explicitLanguage(prompt) ?? userTexts.map(explicitLanguage).find(Boolean) ?? userTexts.map(textLanguage).find(Boolean) ?? history.map((item) => textLanguage(item.text)).find(Boolean) ?? textLanguage(prompt) ?? "en"
}
function planLanguage(state: any) { return state.displayLanguage ?? explicitLanguage(state.goal ?? "") ?? textLanguage(state.goal ?? "") ?? "en" }
function isTerminal(state: any) { return !state || ["stopped", "complete"].includes(state.stage) }
function revisionQuestion(state: any) {
  return label(state, "The proposal was not approved. What would you like to change?", "この案は承認せず、相談を続けます。変更したい点を教えてください。")
}
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
function checkSummary(check: any) {
  return typeof check === "string" ? check : `${check.id}: ${[check.command, ...(check.args ?? [])].join(" ")} (required: ${check.required !== false}, cwd: ${check.cwd ?? "."})`
}
function planSummary(state: any, plan: any) {
  const lines = contractSummary(state, plan.hardContract ?? {})
  lines.push(`${label(state, "Expected files", "想定ファイル")}: ${(plan.softPlan?.expectedFiles ?? []).join(", ") || label(state, "none", "なし")}`)
  lines.push(label(state, "Phases", "フェーズ") + ":")
  for (const phase of plan.phases ?? []) {
    lines.push(`  ${phase.id}: ${(phase.todos ?? []).map((todo: any) => todo.text ?? todo.title ?? todo.id).join("; ")}`)
    for (const check of phase.checks ?? []) {
      lines.push(`    ${label(state, "Check", "検証")}: ${checkSummary(check)}`)
    }
    for (const file of phase.evidenceRequired ?? []) lines.push(`    ${label(state, "Evidence", "確認する成果物")}: ${file}`)
  }
  return lines
}
function approvalText(state: any, proposal: any) {
  const kind = { initial: label(state, "initial plan", "初回計画"), plan: label(state, "plan revision", "作業途中の計画改訂"), hard: label(state, "scope change", "作業範囲の変更"), final: label(state, "task completion", "最終完了"), decision: label(state, "human decision", "人間の判断が必要な質問") }[proposal.kind as "initial" | "plan" | "hard" | "final" | "decision"] ?? proposal.kind
  const detail = proposal.kind === "plan"
    ? `${label(state, "Current approved plan", "現在の承認済み計画")}:\n${planSummary(state, { ...state.plan, hardContract: state.hardContract, softPlan: state.softPlan, phases: state.phases }).join("\n")}\n${label(state, "Proposed plan", "改訂後の計画")} — ${label(state, "Compare scope, checks, and remaining phases before approving", "承認前に作業範囲・検証条件・残りのフェーズを比較してください")}:\n${planSummary(state, proposal.patch).join("\n")}`
    : proposal.kind === "hard"
    ? `${label(state, "Current boundary", "現在の作業範囲")}:\n${contractSummary(state, state.hardContract).join("\n")}\n${label(state, "Boundary after change", "変更後の作業範囲")}:\n${contractSummary(state, { ...state.hardContract, ...proposal.patch }).join("\n")}`
    : proposal.kind === "final"
      ? `${label(state, "Goal", "目的")}: ${state.goal}\n${label(state, "Changed files", "変更ファイル")}: ${display(state.changed_files)}\n${label(state, "Completed phases", "完了したフェーズ")}: ${display(state.completed)}\n${label(state, "Validation results", "検証結果")}: ${display(state.validation_results)}\n${label(state, "Pending work", "未完了の作業")}: ${display(state.pending)}`
      : proposal.kind === "initial" ? planSummary(state, proposal.patch).join("\n") : display(proposal.patch)
  const response = proposal.kind === "decision"
    ? label(state, "Answer the question; a generic approval is not a decision.", "質問に回答してください。単なる承認では判断できません。")
    : label(state, "Reply OK to approve, NG to discuss changes, or describe what to revise.", "OK で承認、NG で相談・修正に戻ります。変更したい内容をそのまま伝えても構いません。")
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
      : state?.stage === "awaiting_human_approval" ? pendingProposal(state)?.kind === "plan" ? "plan revision" : "scope" : undefined
  const special = state?.stage === "awaiting_revision" ? "Awaiting feedback"
    : pendingProposal(state)?.kind === "decision" ? "Awaiting decision"
    : waiting ? `Awaiting approval (${waiting})`
      : state?.stage === "paused" ? "Paused" : state?.stage === "stopped" ? "Stopped"
      : !state ? "Armed" : undefined
  const status = special ? ctx.ui.theme?.fg("accent", ctx.ui.theme.bold(special)) ?? special : undefined
  const role = waiting || ["paused", "stopped", "complete"].includes(state?.stage) ? undefined : state?.role
  const modelName = (ref: string) => ref.split("/").slice(1).join("/") || ref
  const frontier = `${role === "frontier" ? ">" : ""}F:${modelName(names.frontierModel)}`
  const cheap = `${role === "cheap" ? ">" : ""}C:${modelName(names.cheapModel)}`
  const thinking = ctx.thinkingLevel ? `T:${ctx.thinkingLevel}` : undefined
  return `Prewalk: ${[status, steps.join(" → "), `${frontier} ${cheap}`, thinking].filter(Boolean).join(" | ")}`
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
    for (const check of phase.checks ?? []) lines.push(`- ${label(state, "Check", "検証")}: ${checkSummary(check)}`)
    for (const file of phase.evidenceRequired ?? []) lines.push(`- ${label(state, "Evidence", "確認する成果物")}: ${file}`)
    lines.push("")
  }
  lines.push(label(state, "## Current state", "## 現在の状態"), "", `- ${label(state, "Current step", "現在の作業")}: ${state.current_step ?? label(state, "none", "なし")}`, `- ${label(state, "Pending", "未完了")}: ${(state.pending ?? []).join("; ") || label(state, "none", "なし")}`, `- ${label(state, "Changed files", "変更ファイル")}: ${(state.changed_files ?? []).join(", ") || label(state, "none", "なし")}`)
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8")
}

export default function (pi: ExtensionAPI) {
  let latestCtx: ExtensionContext | undefined
  const modelSelectionOrigin = new AsyncLocalStorage<boolean>()
  let modelSwitchQueue: Promise<boolean> = Promise.resolve(true)
  let activeModelSwitch: { userModel: ExtensionContext["model"] } | undefined
  let stoppingModel: { generation: number; model: ExtensionContext["model"] } | undefined
  let runtimeGeneration = 0
  let armed: { frontierModel: string; cheapModel: string; routing: Record<string, unknown>; sessionId?: string } | undefined
  let handledCurrentTurn = false
  let routingGeneration = 0
  let shownProposal: { runId: string; sessionId: string; workspace: string; id: string; baseRevision: string; hardRevision: number } | undefined
  const createRuntime = () => {
    const instance = ++runtimeGeneration
    return createPrewalkRuntime({ deps: {
    cwd: process.cwd(),
    appendEntry: (type: string, data: unknown) => {
      if (instance !== runtimeGeneration) throw new Error("Prewalk runtime was replaced")
      return pi.appendEntry(type, data)
    },
    getBranch: () => latestCtx?.sessionManager.getBranch() ?? [],
    findModel: (ref: string) => latestCtx ? resolveModel(latestCtx, ref) : undefined,
    setModel: async (_model: unknown, ref: string) => instance === runtimeGeneration && latestCtx ? switchModel(ref, latestCtx) : false,
    sendMessage: (message: any) => {
      const current = snapshotState()
      if (instance !== runtimeGeneration || isTerminal(current) || current.runId !== message.state.runId) return
      const content = routingPrompt(message)
      if (content === undefined || snapshotState()?.stage === "stopped") {
        latestCtx?.abort()
        notify(latestCtx, "Prewalk stopped: mandatory review context exceeds the budget", "error")
        return
      }
      pi.sendMessage({ customType: "prewalk-routing", content, display: true, details: { runId: message.state.runId, stage: message.state.stage, reason: message.reason } }, { deliverAs: "steer", triggerTurn: true })
    },
    notify: (message: string) => { if (instance === runtimeGeneration) latestCtx?.ui.notify(message, "info") },
  } })
  }
  let runtime = createRuntime()

  const notify = (ctx: ExtensionContext | undefined, text: string, kind: "info" | "warning" | "error" = "info") => ctx?.ui.notify(text, kind)
  const snapshotState = () => runtime.state()
  const updateStatus = (ctx: ExtensionContext | undefined) => {
    if (ctx) ctx.ui.setStatus("prewalk", snapshotState()?.stage === "stopped" ? undefined : statusLine(ctx, snapshotState(), armed))
  }
  const persistView = (ctx: ExtensionContext | undefined) => {
    const state = snapshotState()
    if (isTerminal(state)) return
    if (ctx) writePlanView(ctx, state)
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

  function switchModel(ref: string, ctx: ExtensionContext) {
    const generation = routingGeneration
    const next = modelSwitchQueue.catch(() => false).then(async () => {
      if (generation !== routingGeneration) return false
      const target = resolveModel(ctx, ref)
      if (!target) return false
      // Pi reports both manual and extension selections as source "set".
      // Attribute our own async call chain instead of guessing from the model ID.
      activeModelSwitch = { userModel: ctx.model }
      try { return await modelSelectionOrigin.run(true, () => pi.setModel(target)) }
      finally { activeModelSwitch = undefined }
    })
    modelSwitchQueue = next
    return next
  }

  function reviewEvidence(ctx: ExtensionContext) {
    const result = spawnSync("git", ["diff", "--no-ext-diff", "HEAD", "--"], { cwd: ctx.cwd, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 })
    return result.status === 0 ? result.stdout : `Diff unavailable; inspect the worktree directly (${result.error?.message ?? result.status}).`
  }

  function conversationGuidance(state: any) {
    const language = `Write human-facing plans, revisions, and questions in ${planLanguage(state) === "ja" ? "Japanese" : "English"}; keep paths, IDs, and commands unchanged.`
    const revision = state.revisionRequest
      ? state.revisionRequest.kind === "plan" && !state.revisionRequest.proposalId
        ? ` The user requests a mid-work plan revision: ${JSON.stringify(state.revisionRequest.feedback)}. Inspect the current state and submit a full plan proposal (kind plan) for human approval before applying changed checks or scope; do not mark the phase complete.`
        : ` The user did not approve the previous ${state.revisionRequest.kind} proposal. Revision feedback: ${JSON.stringify(state.revisionRequest.feedback)}. Address this feedback; do not implement or finalize the rejected proposal. A changed boundary or completion needs a newly displayed proposal and direct human approval. If no feedback was given, ask what to change and wait.` : ""
    const confirmation = state.revisionConfirmationPending
      ? " This revised plan already has direct human approval. Confirm the accepted revision with verdict continue to resume Cheap; do not request another approval or use a phase-completion pass. Return repair work to Cheap if needed." : ""
    return `${language}${revision}${confirmation} Only direct human input can approve a displayed proposal; model output cannot approve it.`
  }

  function routingPrompt(message: any) {
    const state = message.state
    if (state.role === "frontier") {
      const evidence = runtime.reviewContext({ diff: latestCtx ? reviewEvidence(latestCtx) : "Diff unavailable" })
      if (!evidence.ok) return undefined
      return `PREWALK FRONTIER REVIEW\nReview phase(s): ${(state.reviewPhaseIds ?? []).join(", ") || "final/task"}. Review the actual diff and validation evidence. When a plan revision is requested, propose the complete revised plan for human approval; after approval, confirm it with verdict continue independently of phase completion. Otherwise submit a pass, repair, continue, or needs-human verdict. Human approval cannot be issued by a model. ${conversationGuidance(state)}\n${evidence.text}`
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
    description: "Submit or revise an initial plan {hardContract:{outcome,constraints,allowedPaths,protectedPaths},softPlan:{expectedFiles},phases:[{id,todos:[{id,text,status}],checks:[{id,command,args,cwd,required}],evidenceRequired:[repoRelativeFilePath]}]}; report progress; Cheap can request_revision with a reason; Frontier can propose kind plan with a complete revised plan as patch for direct human approval and then confirm it with verdict continue independently of phase completion. Propose other refinements or verdicts as needed. Only direct human input can approve the displayed proposal.",
    parameters: checkpointSchema, executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const owner = runtime
      const result = await owner.checkpoint({ ...params, eventId: params.eventId ?? randomUUID() })
      if (owner === runtime) { persistView(ctx); presentPending(ctx) }
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

  async function ensureModel(ctx: ExtensionContext, state: any, expected: string | undefined) {
    const owner = runtime
    await modelSwitchQueue.catch(() => false)
    if (owner !== runtime || isTerminal(snapshotState())) return false
    let ready = true
    if (expected && modelRef(ctx.model) !== expected) {
      try { ready = await switchModel(expected, ctx) } catch { ready = false }
    }
    if (owner !== runtime || isTerminal(snapshotState()) || snapshotState()?.runId !== state.runId) return false
    if (!ready) notify(ctx, label(state,
      "Prewalk could not select the required model. Work remains on hold; the next reply will retry, or use /prewalk off to return to ordinary work.",
      "必要なモデルを選べないため、作業を保留しています。次の返信で再試行します。/prewalk off で通常の会話に戻れます。"), "warning")
    return ready
  }

  async function recoverPaused(ctx: ExtensionContext) {
    const currentRuntime = runtime
    const state = snapshotState()
    if (state?.stage !== "paused") return false
    const nextStage = state.resumeStage === "awaiting_human_approval" ? state.proposalResumeStage : state.resumeStage
    const expected = ["awaiting_approval", "awaiting_revision", "awaiting_final_approval", "frontier_plan", "frontier_initial", "frontier_review", "frontier_review_pending"].includes(nextStage)
      ? state.frontierModel : ["cheap", "cheap_pending"].includes(nextStage) ? state.cheapModel : undefined
    if (!await ensureModel(ctx, state, expected) || runtime !== currentRuntime) return false
    const resumed = await currentRuntime.resume()
    if (!resumed.ok || currentRuntime !== runtime || isTerminal(snapshotState())) return false
    presentPending(ctx)
    if (snapshotState()?.stage === "awaiting_revision") notify(ctx, revisionQuestion(snapshotState()))
    updateStatus(ctx)
    return true
  }

  async function restoreSession(ctx: ExtensionContext) {
    routingGeneration += 1
    latestCtx = ctx
    armed = undefined
    shownProposal = undefined
    runtime = createRuntime()
    const restored = await runtime.restore({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd })
    if (restored.ok && !restored.terminal) {
      await recoverPaused(ctx)
    } else if (restored.reason && restored.reason !== "no-matching-state") {
      notify(ctx, `Prewalk could not restore: ${restored.reason}`, "warning")
    }
    updateStatus(ctx)
  }
  pi.on("session_start", async (_event, ctx) => restoreSession(ctx))
  pi.on("session_tree", async (_event, ctx) => restoreSession(ctx))

  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx
    if (armed && !runtime.state() && event.prompt.trim()) {
      const sessionId = ctx.sessionManager.getSessionId()
      if (armed.sessionId && armed.sessionId !== sessionId) { armed = undefined; return }
      const startingRuntime = runtime
      const route = armed
      const started = await startingRuntime.start({ runId: randomUUID(), sessionId, workspace: ctx.cwd, goal: event.prompt, displayLanguage: sessionLanguage(ctx, event.prompt), frontierModel: route.frontierModel, cheapModel: route.cheapModel })
      if (armed !== route || runtime !== startingRuntime || (started.ok && isTerminal(snapshotState()))) return
      if (!started.ok) { notify(ctx, `Prewalk could not start: ${started.reason}`, "error"); return }
      const planPath = join(ctx.cwd, PREWALK_PLAN_PATH)
      if (existsSync(planPath)) renameSync(planPath, `${planPath}.prewalk-backup-${started.state.runId}`)
      armed.sessionId = sessionId
      updateStatus(ctx)
    }
    const language = explicitLanguage(event.prompt)
    if (language) await runtime.setDisplayLanguage(language)
    const state = snapshotState()
    if (state && !["stopped", "complete", "paused"].includes(state.stage)) {
      const stageGuidance = state.stage === "frontier_plan"
        ? `Discover repository-specific checks from instructions, CI, build files, and tests. Write the human plan and all human-readable plan fields in ${planLanguage(state) === "ja" ? "Japanese" : "English"}, following the user's explicit language preference; keep paths, IDs, and commands unchanged. Then submit a structured plan with prewalk_checkpoint action submit_plan. Shape: {hardContract:{outcome:string,constraints:string[],allowedPaths:string[],protectedPaths:string[]},softPlan:{expectedFiles:string[]},phases:[{id:string,todos:[{id:string,text:string,status:'pending'}],checks:[{id:string,command:string,args:string[],cwd:string,required:true}]}]}. A phase without executable checks needs evidenceRequired:string[] of repository-relative artifact files (record their existence via prewalk_checkpoint progress evidence). Do not edit source before the user approves the proposal.`
        : state.stage === "awaiting_approval"
          ? "The initial plan is awaiting human approval. If the user asks to revise it, submit a revised initial plan with prewalk_checkpoint action submit_plan; this supersedes the previous proposal and requires approval of the new exact proposal. Do not edit source."
          : state.stage === "frontier_initial"
            ? "The plan is approved. Make one successful representative source edit inside its hard contract, then stop; Prewalk will hand off to Cheap."
          : state.stage === "frontier_review"
            ? "Review the current diff, plan, pending work, and actual fresh validation evidence. For a requested plan revision, propose kind plan with a complete updated plan and wait for human approval; after approval confirm with verdict continue independently of phase completion. Otherwise submit pass, repair, continue, or needs-human; do not approve proposals yourself."
            : state.role === "cheap"
              ? "Implement only inside the approved hard contract. For a mid-work plan change, use prewalk_checkpoint request_revision with a reason; do not change checks through progress or edit the plan view as authority. Update current-phase TODOs with prewalk_checkpoint progress and report readiness only when required checks/evidence are fresh."
              : "Preserve the approved task boundary and use prewalk_checkpoint for permitted state transitions."
      event.systemPromptOptions.appendSystemPrompt = (event.systemPromptOptions.appendSystemPrompt ?? "") + `\n\nPREWALK STATE\nRole: ${state.role}; stage: ${state.stage}. ${stageGuidance} ${conversationGuidance(state)}`
    }
  })

  pi.on("tool_call", (event) => {
    if (isTerminal(snapshotState())) return
    const result = runtime.observeToolCall({ id: event.toolCallId, name: event.toolName, input: event.input })
    if (result?.block) return { block: true, reason: result.reason }
  })
  pi.on("tool_result", (event) => {
    if (isTerminal(snapshotState())) return
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
    if (!isTerminal(state)) {
      const result = await runtime.turnStart({ eventId: `turn:${state.runId}:${randomUUID()}`, model: modelRef(ctx.model) })
      if (result.action === "stopped") { notify(ctx, `Prewalk stopped: ${result.reason}`, "error"); ctx.abort?.() }
      updateStatus(ctx)
    }
  })
  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx
    handledCurrentTurn = true
    const owner = runtime
    const state = owner.state()
    if (isTerminal(state)) return
    const id = `${state.runId}:${event.messageEntryId}`
    const ids = event.toolResultEntryIds ?? []
    if (ids.length) await owner.completeToolBatch({ eventId: `batch:${id}`, toolIds: ids })
    if (owner !== runtime || isTerminal(owner.state())) return
    const result = await owner.turnEnd({ eventId: `turn-end:${id}`, message: event.message })
    if (owner !== runtime) return
    reportSwitch(ctx, result)
    persistView(ctx)
    presentPending(ctx)
  })
  pi.on("agent_before_settle", async (event, ctx) => {
    latestCtx = ctx
    if (handledCurrentTurn || event.outcome !== "completed") return
    const state = snapshotState()
    if (isTerminal(state)) return
    const owner = runtime
    const result = await owner.beforeSettle({ eventId: `settle:${state.runId}:${state.stateRevision}`, message: undefined })
    if (owner !== runtime) return
    reportSwitch(ctx, result)
    persistView(ctx)
    presentPending(ctx)
  })
  pi.on("model_select", (event, ctx) => {
    const selected = modelRef(event.model)
    if (modelSelectionOrigin.getStore()) return
    if (activeModelSwitch) activeModelSwitch.userModel = event.model
    if (stoppingModel?.generation === routingGeneration) stoppingModel.model = event.model
    if (isTerminal(snapshotState())) return
    void runtime.modelSelected(selected ?? "unknown").then((result) => {
      if (!result.ok) notify(ctx, `Prewalk paused after external model selection (${selected ?? "unknown"})`, "warning")
      updateStatus(ctx)
    }).catch(() => notify(ctx, "Prewalk model selection could not be recorded", "error"))
  })
  pi.on("thinking_level_select", (_event, ctx) => updateStatus(ctx))
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
    return { messages: [...event.messages, { role: "custom", customType: "prewalk-current-stage", display: false, timestamp: Date.now(), content: `Prewalk role: ${state.role}; stage: ${state.stage}; phase: ${state.currentPhaseId ?? "none"}. ${state.role === "cheap" ? "Stay inside the approved hard boundary; report phase TODOs and observed checks, then wait for Frontier review." : "Inspect plan, changed paths and evidence; record your review verdict or an exact proposal."} ${conversationGuidance(state)}` }] }
  })

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || ctx.mode !== "tui" || !ctx.hasUI || event.images?.length) return { action: "continue" }
    latestCtx = ctx
    let state = snapshotState()
    if (isTerminal(state)) return { action: "continue" }
    if (state.sessionId !== ctx.sessionManager.getSessionId() || state.workspace !== resolve(ctx.cwd)) return { action: "continue" }
    const answer = event.text.trim().toLocaleLowerCase("en")
    const rejection = /^(?:ng|却下)(?:$|[\s、,:：]\s*(.*))$/is.exec(event.text.trim())
    const shortAnswer = SHORT_ANSWERS.has(answer)
    if (state.stage === "paused") {
      if (!await recoverPaused(ctx)) return { action: "handled" }
      state = snapshotState()
      // A reply to an old view cannot approve a proposal newly displayed during recovery.
      if (shortAnswer) return { action: "handled" }
    }
    const feedback = rejection ? rejection[1]?.trim() ?? "" : event.text.trim()
    if (state.stage === "awaiting_revision") {
      const savedFeedback = state.revisionRequest?.feedback
      const retryFeedback = shortAnswer ? (rejection ? "" : savedFeedback) : feedback
      if (!retryFeedback) { notify(ctx, revisionQuestion(state)); return { action: "handled" } }
      const saved = await runtime.provideRevisionFeedback(retryFeedback, { resume: false })
      if (!saved.ok || !await ensureModel(ctx, state, state.frontierModel)) return { action: "handled" }
      const result = await runtime.provideRevisionFeedback(retryFeedback)
      if (!result.ok) return { action: "handled" }
      persistView(ctx)
      return shortAnswer ? { action: "transform", text: retryFeedback } : { action: "continue" }
    }
    const proposal = pendingProposal(state)
    if (!proposal) return { action: "continue" }
    const affirmative = COMMON_APPROVALS.has(answer) || (PROPOSAL_APPROVALS[proposal.kind]?.has(answer) ?? false)
    // Initial revisions already have a checkpoint path. Later proposal feedback must reopen review.
    const revisionFeedback = !affirmative && !shortAnswer && event.text.trim() && ["hard", "plan", "final"].includes(proposal.kind)
    const decisionAnswer = proposal.kind === "decision" && !shortAnswer && !rejection && event.text.trim()
    if (!affirmative && !rejection && !revisionFeedback && !decisionAnswer) return { action: "continue" }
    if (proposal.kind === "decision" && !decisionAnswer) {
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
    if (decisionAnswer) {
      if (!await ensureModel(ctx, state, state.frontierModel)) { presentPending(ctx); return { action: "handled" } }
      const result = await runtime.answerQuestion(proposal.id, event.text, { baseRevision: proposal.baseRevision })
      if (!result.ok) { notify(ctx, result.reason, "error"); presentPending(ctx); return { action: "handled" } }
      persistView(ctx)
      return { action: "continue" }
    }
    if (rejection || revisionFeedback) {
      const result = await runtime.rejectProposal(proposal.id, { baseRevision: proposal.baseRevision, feedback })
      if (!result.ok) { notify(ctx, result.reason, "error"); return { action: "handled" } }
      persistView(ctx)
      if (!feedback) { notify(ctx, revisionQuestion(state)); return { action: "handled" } }
      if (!await ensureModel(ctx, snapshotState(), state.frontierModel)) return { action: "handled" }
      const resumed = await runtime.provideRevisionFeedback(feedback)
      persistView(ctx)
      return { action: resumed.ok ? "continue" : "handled" }
    }
    const result = await runtime.approve(proposal.id, { baseRevision: proposal.baseRevision })
    persistView(ctx)
    updateStatus(ctx)
    if (!result.ok) {
      notify(ctx, `${label(state, "Approval refused", "承認できません")}: ${result.reason}`, "error")
      return { action: "handled" }
    }
    const approved = snapshotState()
    if (approved && ["frontier_initial", "cheap_pending", "cheap", "frontier_review"].includes(approved.stage)) {
      pi.sendUserMessage(label(state, "Continue the approved Prewalk task in this session.", "このセッションで承認済みの Prewalk 作業を続けてください。"), { deliverAs: "followUp" })
    }
    notify(ctx, label(state, "Proposal approved", "提案を承認しました"))
    return { action: "handled" }
  })

  pi.registerCommand("prewalk", {
    description: "Start Prewalk, inspect status, or turn it off. Discuss proposals using OK / NG or revision feedback.",
    handler: async (args, ctx) => {
      latestCtx = ctx
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const [command] = parts
      if (command === "off") {
        const generation = ++routingGeneration
        const pendingSwitch = modelSwitchQueue
        stoppingModel = { generation, model: activeModelSwitch?.userModel ?? ctx.model }
        armed = undefined
        shownProposal = undefined
        await runtime.cancel()
        // Pi cannot cancel setModel during authentication. Settle it before confirming off,
        // then restore the user's selection rather than leaving a late routing target active.
        await pendingSwitch.catch(() => false)
        if (generation !== routingGeneration) return
        while (generation === routingGeneration) {
          const previous = stoppingModel?.model
          if (!previous || modelRef(ctx.model) === modelRef(previous)) break
          let restored = false
          try { restored = await switchModel(modelRef(previous)!, ctx) } catch { /* Report recovery failure below. */ }
          if (generation !== routingGeneration) return
          if (!restored) {
            notify(ctx, "Prewalk is off, but the previous model could not be restored. Select the desired model in Pi.", "warning")
            break
          }
          // Retry only for a new human choice made during the preceding restoration.
          if (modelRef(stoppingModel?.model) === modelRef(previous)) break
        }
        if (generation !== routingGeneration) return
        stoppingModel = undefined
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
      if (parts.length > 2 || parts.some((part) => !/^[^/\s]+\/.+/.test(part))) {
        ctx.ui.notify("Usage: /prewalk [<frontier-model> <cheap-model>] | status | off", "error")
        return
      }
      try {
        const generation = ++routingGeneration
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
        if (["stopped", "complete"].includes(snapshotState()?.stage ?? "")) { runtime = createRuntime(); shownProposal = undefined }
        await runtime.configure(routing)
        if (generation !== routingGeneration) return
        const selected = modelRef(ctx.model)
        const selectedFrontier = selected === models.firstModel || await switchModel(models.firstModel, ctx)
        if (generation !== routingGeneration) return
        if (!selectedFrontier) throw new Error(`Could not select Frontier model ${models.firstModel}`)
        armed = { frontierModel: models.firstModel, cheapModel: models.secondModel, routing: { ...routing } }
        updateStatus(ctx)
        ctx.ui.notify(`Prewalk armed for the next user prompt: ${models.firstModel} -> ${models.secondModel}. Submit the task prompt next.`, "info")
      } catch (error) {
        ctx.ui.notify(`Prewalk: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    },
  })
}
