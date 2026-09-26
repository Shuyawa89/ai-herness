import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, relative, resolve, sep } from "node:path"
import {
  PREWALK_PLAN_PATH,
  PREWALK_STATE_ENTRY,
  ROUTING_DEFAULTS,
  approveProposal,
  buildReviewContext,
  changedSinceBaseline,
  createProposal,
  createTaskState,
  decideRoute,
  fingerprintSnapshot,
  isPathAllowed,
  isPathWithin,
  isPhaseReady,
  isPlanPath,
  isScratchPath,
  normalizeRepoPath,
  resolveRoutingConfig,
} from "./prewalk-core.mjs"

const FRONTIER_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "prewalk_checkpoint", "prewalk_validate"])
const ROUTABLE_STAGES = new Set(["frontier_plan", "awaiting_approval", "awaiting_human_approval", "awaiting_final_approval", "frontier_initial", "cheap", "frontier_review", "frontier_review_pending", "cheap_pending"])

function safeClone(value) { return structuredClone(value) }
function commandKey(command, args = []) { return [String(command).trim(), ...args.map(String)].join(" ").replace(/\s+/g, " ").trim() }
function checkKey(command) { return String(command).replace(/\s+/g, " ").trim() }
function sha(value) { return createHash("sha256").update(value).digest("hex") }

export function captureGitSnapshot(workspace) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workspace, encoding: "utf8", timeout: 10000 })
  if (result.error || result.status !== 0) throw new Error("Git snapshot unavailable")
  const paths = result.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3))
  const snapshot = {}
  for (const raw of paths) {
    let path
    try { path = normalizeRepoPath(raw) } catch { continue }
    const absolute = resolve(workspace, path)
    try {
      const stat = lstatSync(absolute)
      const content = stat.isSymbolicLink() ? `symlink:${readlinkSync(absolute)}` : stat.isFile() ? readFileSync(absolute) : `mode:${stat.mode}`
      snapshot[path] = sha(content)
    } catch {
      snapshot[path] = "<deleted>"
    }
  }
  return snapshot
}

function findCheck(state, id) {
  for (const phase of state.phases) {
    const check = (phase.checks ?? []).find((item) => (typeof item === "string" ? item : item.id) === id)
    if (check) return { phase, check: typeof check === "string" ? { id: check } : check }
  }
  return undefined
}

function validatePlan(plan, workspace) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return "plan must be an object"
  const contract = plan.hardContract
  if (!contract || typeof contract.outcome !== "string" || !Array.isArray(contract.constraints)) return "hardContract needs outcome and constraints"
  if (!Array.isArray(contract.allowedPaths) || !Array.isArray(contract.protectedPaths) ||
    [...contract.allowedPaths, ...contract.protectedPaths].some((path) => typeof path !== "string")) return "hardContract needs path arrays"
  if (plan.softPlan?.expectedFiles !== undefined && !Array.isArray(plan.softPlan.expectedFiles)) return "softPlan expectedFiles must be an array"
  for (const path of plan.softPlan?.expectedFiles ?? []) {
    if (typeof path !== "string" || !isPathAllowed(path, contract.allowedPaths, contract.protectedPaths)) return `soft expected file is outside the hard boundary: ${path}`
  }
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) return "plan needs at least one phase"
  const phaseIds = new Set()
  const checkIds = new Set()
  for (const phase of plan.phases) {
    if (!phase || typeof phase.id !== "string" || phase.id.trim() === "" || phaseIds.has(phase.id)) return "phase IDs must be unique non-empty strings"
    phaseIds.add(phase.id)
    if (!Array.isArray(phase.todos) || phase.todos.length === 0) return `phase ${phase.id} needs TODOs`
    const todoIds = new Set()
    for (const todo of phase.todos) {
      if (typeof todo?.id !== "string" || todoIds.has(todo.id)) return `phase ${phase.id} has invalid TODO IDs`
      todoIds.add(todo.id)
      if (!(["pending", "in_progress", "ready", "completed"].includes(todo.status ?? "pending"))) return `TODO ${todo.id} has invalid status`
      todo.status ??= "pending"
    }
    for (const check of phase.checks ?? []) {
      if (typeof check === "string") {
        if (checkIds.has(check)) return `duplicate check ${check}`
        checkIds.add(check)
        continue
      }
      if (!check || typeof check.id !== "string" || !check.id || typeof check.command !== "string" || !check.command.trim() || checkIds.has(check.id)) return `phase ${phase.id} has invalid validation check`
      if (!Array.isArray(check.args ?? [])) return `check ${check.id} args must be an array`
      checkIds.add(check.id)
      const cwd = check.cwd ?? "."
      const absoluteCwd = resolve(workspace, cwd)
      if (!isPathWithin(absoluteCwd, workspace)) return `check ${check.id} cwd escapes workspace`
      try { if (!isPathWithin(realpathSync(absoluteCwd), realpathSync(workspace))) return `check ${check.id} cwd escapes through a symlink` } catch { return `check ${check.id} cwd does not exist` }
      check.args ??= []
      check.phaseId ??= phase.id
      check.required ??= true
    }
    if (!(phase.checks ?? []).length && !(Array.isArray(phase.evidenceRequired) && phase.evidenceRequired.length)) return `phase ${phase.id} needs checks or concrete evidence requirements`
    for (const artifact of phase.evidenceRequired ?? []) {
      if (typeof artifact !== "string") return `phase ${phase.id} evidence must be repository-relative file paths`
      try { if (normalizeRepoPath(artifact) !== artifact) return `invalid evidence path: ${artifact}` } catch { return `invalid evidence path: ${artifact}` }
    }
  }
  for (const path of [...(contract.allowedPaths ?? []), ...(contract.protectedPaths ?? []), ...(plan.softPlan?.expectedFiles ?? [])]) {
    try { normalizeRepoPath(path.endsWith("/") ? path.slice(0, -1) : path) } catch { return `invalid scope path: ${path}` }
  }
  return undefined
}

function checkedPath(rawPath, workspace, realpath = realpathSync) {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) return { error: "mutation path is invalid" }
  const absolute = resolve(workspace, rawPath)
  if (!isPathWithin(absolute, workspace)) return { error: "mutation path escapes workspace" }
  let candidate = absolute
  let suffix = []
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    suffix.unshift(candidate.slice(parent.length + 1))
    candidate = parent
  }
  try {
    const realBase = realpath(candidate)
    const actual = resolve(realBase, ...suffix)
    if (!isPathWithin(actual, realpath(workspace))) return { error: "mutation path escapes workspace through a symlink" }
  } catch {
    if (!isPathWithin(absolute, workspace)) return { error: "mutation path escapes workspace" }
  }
  const relativePath = relative(workspace, absolute).split(sep).join("/")
  try { return { path: normalizeRepoPath(relativePath), absolute } } catch { return { error: "mutation path escapes workspace" } }
}

function isPlainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value) }

export function buildBoundedReviewMessages(messages, budgetChars) {
  const source = Array.isArray(messages) ? messages : []
  const size = (message) => JSON.stringify(message).length
  const calls = new Map()
  const results = new Map()
  source.forEach((message, index) => {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const ids = message.content.filter((part) => part?.type === "toolCall").map((part) => part.id)
      if (ids.length) calls.set(index, ids)
    }
    if (message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, index)
  })
  const consumed = new Set()
  const units = []
  source.forEach((message, index) => {
    if (consumed.has(index)) return
    if (message?.role === "toolResult") return
    const ids = calls.get(index) ?? []
    if (ids.length) {
      const resultIndexes = ids.map((id) => results.get(id))
      if (resultIndexes.some((value) => value === undefined)) return
      const indexes = [index, ...resultIndexes].sort((a, b) => a - b)
      for (const at of indexes) consumed.add(at)
      units.push({ indexes, size: indexes.reduce((total, at) => total + size(source[at]), 0), mandatory: false })
    } else {
      consumed.add(index)
      units.push({ indexes: [index], size: size(message), mandatory: message?.role === "user" })
    }
  })
  const mandatory = units.filter((unit) => unit.mandatory)
  const mandatorySize = mandatory.reduce((total, unit) => total + unit.size, 0)
  if (mandatorySize > budgetChars) return { ok: false, reason: "mandatory-context-exceeds-budget", messages: [] }
  const chosen = new Set(mandatory)
  let used = mandatorySize
  for (const unit of [...units].reverse()) {
    if (chosen.has(unit) || used + unit.size > budgetChars) continue
    chosen.add(unit)
    used += unit.size
  }
  const indexes = [...chosen].flatMap((unit) => unit.indexes).sort((a, b) => a - b)
  return { ok: true, messages: indexes.map((index) => source[index]), truncated: indexes.length !== source.length }
}

export function createPrewalkRuntime({ config = {}, deps = {} } = {}) {
  let limits = resolveRoutingConfig(config)
  let task
  let completedTools = []
  let serial = Promise.resolve()
  let lastTurnStarted = 0
  const serialize = (fn) => {
    const result = serial.then(fn)
    serial = result.catch(() => {})
    return result
  }

  const now = () => deps.now?.() ?? new Date().toISOString()
  const snapshot = async () => {
    const result = await (deps.snapshot?.(task?.workspace) ?? captureGitSnapshot(task?.workspace ?? deps.cwd ?? process.cwd()))
    if (!isPlainObject(result)) throw new Error("Worktree snapshot is not an object")
    return result
  }
  const audit = (type, detail = {}) => ({
    timestamp: now(),
    runId: task?.runId,
    sessionId: task?.sessionId,
    eventId: detail.eventId,
    type,
    currentModel: detail.currentModel ?? task?.currentModel,
    previousModel: detail.previousModel ?? task?.previousModel,
    producingModel: detail.producingModel ?? task?.producingModel,
    routingReason: detail.reason ?? task?.lastEscalationReason,
    step: task?.step_count ?? 0,
    toolIds: detail.toolIds ?? [],
    validationOutcome: detail.validationOutcome,
    counters: { failure: task?.failure_count ?? 0, escalation: task?.escalation_count ?? 0, retry: task?.retry_count ?? 0, step: task?.step_count ?? 0 },
    changedFiles: task?.changed_files ?? [],
    planRevision: task?.planRevision ?? 0,
    sourceRevision: task?.sourceRevision,
    ...detail,
  })
  async function persist(type, detail = {}) {
    try {
      task.stateRevision = (Number.isSafeInteger(task.stateRevision) ? task.stateRevision : 0) + 1
      await deps.appendEntry?.(PREWALK_STATE_ENTRY, { version: 1, state: safeClone(task) })
      await deps.appendEntry?.("prewalk-audit", audit(type, detail))
      return true
    } catch (error) {
      task.stage = "stopped"
      task.stopReason = `persistence-failure: ${error instanceof Error ? error.message : String(error)}`
      task.role = "none"
      try {
        task.stateRevision += 1
        await deps.appendEntry?.(PREWALK_STATE_ENTRY, { version: 1, state: safeClone(task) })
      } catch { /* Storage may be entirely unavailable; never continue in memory-only mode. */ }
      deps.notify?.("Prewalk stopped: required session-state persistence failed")
      return false
    }
  }
  function stop(reason, detail = {}) {
    if (!task) return Promise.resolve({ action: "stopped", reason })
    task.stage = "stopped"
    task.role = "none"
    task.stopReason = reason
    return persist("stopped", { reason, ...detail }).then(() => ({ action: "stopped", reason }))
  }
  function rememberDecision(reason, detail = {}) {
    task.important_decisions.push({ timestamp: now(), reason, ...detail })
    task.lastEscalationReason = reason
  }
  async function routeToFrontier(reason, { phaseId = task.currentPhaseId, includeFinal = false, eventId, toolIds = [], tools = [] } = {}) {
    const observedIds = [...new Set([...toolIds, ...tools.map((tool) => tool.id)])]
    if (task.stage === "frontier_review_pending") {
      task.reviewIncludesFinal ||= includeFinal
      task.reviewPhaseIds = [...new Set([...(task.reviewPhaseIds ?? []), phaseId].filter(Boolean))]
      const persisted = await persist("review-coalesced", { eventId, reason, toolIds: observedIds, tools })
      return persisted ? { action: "review-pending", reason, phaseId, includeFinal: task.reviewIncludesFinal } : { action: "stopped", reason: task.stopReason }
    }
    const decision = decideRoute(task, { type: reason === "validation-threshold" ? "validation-failed" : reason, phaseId, final: includeFinal, recognized: true, streak: limits.failureThreshold }, limits)
    if (decision.action === "stop") return stop(decision.reason, { eventId })
    task.escalation_count += 1
    task.stage = "frontier_review_pending"
    task.role = "frontier"
    task.reviewPhaseId = phaseId
    task.reviewPhaseIds = phaseId ? [phaseId] : []
    task.reviewIncludesFinal = includeFinal
    rememberDecision(reason, { phaseId, includeFinal })
    const persisted = await persist("route-review", { eventId, reason, toolIds: observedIds, tools })
    return persisted ? { action: "review-pending", reason, phaseId, includeFinal } : { action: "stopped", reason: task.stopReason }
  }
  function phaseAt(id) { return task?.phases.findIndex((phase) => phase.id === id) ?? -1 }
  function currentPhase() { return task?.phases.find((phase) => phase.id === task.currentPhaseId) }
  function markStopSync(reason) {
    if (!task) return
    task.stage = "stopped"
    task.role = "none"
    task.stopReason = reason
    void persist("stopped", { reason })
  }
  function stopForLimits(eventId) {
    const decision = decideRoute(task, { type: "limit-check" }, limits)
    if (decision.action === "stop") return stop(decision.reason, { eventId })
    return undefined
  }
  function capturePath(path) {
    return checkedPath(path, task.workspace, deps.realpathSync ?? realpathSync)
  }
  function recordUsageEntry(message) {
    if (!task || message?.role !== "assistant") return Promise.resolve(false)
    const usage = message.usage
    const record = {
      timestamp: now(),
      provider: message.provider,
      model: message.model,
      api: message.api,
      input: usage?.input,
      output: usage?.output,
      cacheRead: usage?.cacheRead,
      cacheWrite: usage?.cacheWrite,
      cost: usage?.cost?.total ?? usage?.cost,
      costIsEstimate: usage?.cost !== undefined,
      attribution: message.provider && message.model ? "assistant-message" : "unknown",
    }
    task.usage.push(record)
    return persist("usage", { producingModel: `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`, usage: record })
  }
  function scheduleDeviation(eventId, path, name) {
    void serialize(() => routeToFrontier("deviation", { eventId: `blocked:${eventId}`, toolIds: [eventId], tools: [{ id: eventId, name }], phaseId: task.currentPhaseId }))
      .catch(() => markStopSync("deviation-routing-failed"))
    return { block: true, reason: `Known out-of-scope or protected path blocked: ${path}`, routeScheduled: true }
  }

  return {
    configure(nextConfig) {
      if (task && !["complete", "stopped"].includes(task.stage)) throw new Error("cannot reconfigure an active Prewalk run")
      limits = resolveRoutingConfig(nextConfig)
    },
    state() { return task ? safeClone(task) : undefined },
    status() {
      if (!task) return { active: false, stage: "idle" }
      return { active: !["complete", "stopped"].includes(task.stage), stage: task.stage, role: task.role, runId: task.runId, currentPhaseId: task.currentPhaseId, counters: { failure: task.failure_count, escalation: task.escalation_count, retry: task.retry_count, step: task.step_count }, stopReason: task.stopReason, budgetShortfall: task.budgetShortfall }
    },
    async start({ runId, sessionId, workspace = deps.cwd ?? process.cwd(), goal, frontierModel, cheapModel, displayLanguage = "en", baseline } = {}) {
      return serialize(async () => {
        if (typeof goal !== "string" || !goal.trim() || !runId || !sessionId || !frontierModel || !cheapModel) return { ok: false, reason: "missing-run-identity-or-goal" }
        const root = resolve(workspace)
        let initial = baseline
        try {
          if (!initial) initial = await (deps.snapshot?.(root) ?? captureGitSnapshot(root))
          if (!isPlainObject(initial)) throw new Error("Worktree snapshot is not an object")
        } catch { return { ok: false, reason: "worktree-snapshot-failed" } }
        task = createTaskState({ runId, sessionId, workspace: root, goal: goal.trim(), frontierModel, cheapModel, config: limits, baseline: initial })
        task.displayLanguage = displayLanguage === "ja" ? "ja" : "en"
        completedTools = []
        task.snapshot = { ...initial }
        task.startedAt = now()
        const ok = await persist("started", { producingModel: frontierModel })
        return { ok, state: safeClone(task) }
      })
    },
    async restore({ sessionId, workspace = deps.cwd ?? process.cwd() } = {}) {
      return serialize(async () => {
        const branch = deps.getBranch?.() ?? []
        let saved
        for (const entry of branch) {
          const data = entry?.customType === PREWALK_STATE_ENTRY ? entry.data : entry?.type === PREWALK_STATE_ENTRY ? entry.data : undefined
          const candidate = data?.state
          if (!candidate || candidate.version !== 1 || !Number.isSafeInteger(candidate.stateRevision) ||
            typeof candidate.runId !== "string" || typeof candidate.sessionId !== "string" ||
            typeof candidate.workspace !== "string" || !Array.isArray(candidate.phases) ||
            !Array.isArray(candidate.proposals) || !Array.isArray(candidate.seenEventIds)) continue
          if (candidate.sessionId !== sessionId || resolve(candidate.workspace) !== resolve(workspace)) continue
          // A new run starts at a lower revision; within the same run, never rewind
          // to a stale or conflicting duplicate state entry appended later.
          if (!saved || candidate.runId !== saved.runId || candidate.stateRevision > saved.stateRevision) saved = candidate
        }
        if (!saved) return { ok: false, reason: "no-matching-state" }
        task = safeClone(saved)
        completedTools = []
        limits = resolveRoutingConfig(saved.config)
        if (["stopped", "complete"].includes(task.stage)) return { ok: true, terminal: true, state: safeClone(task) }
        if (task.stage !== "paused") task.resumeStage = task.stage
        task.stage = "paused"
        task.role = "none"
        const ok = await persist("restored-paused")
        return { ok, state: safeClone(task) }
      })
    },
    async resume() {
      return serialize(async () => {
        if (!task || task.stage !== "paused" || !ROUTABLE_STAGES.has(task.resumeStage)) return { ok: false, reason: "not-resumable" }
        task.stage = task.resumeStage
        task.role = ["awaiting_human_approval", "awaiting_final_approval"].includes(task.stage) ? "none" : task.stage.includes("frontier") || task.stage === "awaiting_approval" ? "frontier" : "cheap"
        delete task.resumeStage
        const ok = await persist("resumed")
        if (!ok) return { ok: false, reason: task.stopReason }
        return { ok, stage: task.stage }
      })
    },
    async checkpoint(input = {}) {
      return serialize(async () => {
        if (!task) return { ok: false, reason: "no-active-run" }
        if (input.eventId && task.seenEventIds.includes(input.eventId)) return { ok: true, reason: "duplicate-event" }
        if (input.eventId) task.seenEventIds.push(input.eventId)
        if (task.stage === "stopped" || task.stage === "complete" || task.stage === "paused") return { ok: false, reason: "run-not-active" }
        if (input.action === "submit_plan") {
          const revising = task.stage === "awaiting_approval" && task.role === "frontier"
          if (!revising && (task.stage !== "frontier_plan" || task.role !== "frontier")) return { ok: false, reason: "plan-submission-not-allowed" }
          const error = validatePlan(input.plan, task.workspace)
          if (error) return { ok: false, reason: error }
          if (revising) {
            const previous = task.proposals.find((proposal) => proposal.id === task.planProposalId && proposal.kind === "initial" && proposal.status === "pending")
            if (!previous) return { ok: false, reason: "initial-plan-revision-requires-pending-proposal" }
            const revised = safeClone(task)
            revised.proposals.find((proposal) => proposal.id === previous.id).status = "superseded"
            task = revised
          }
          const proposal = createProposal(task, { kind: "initial", patch: input.plan, baseRevision: task.sourceRevision })
          task = proposal.state
          task.planProposalId = proposal.proposal.id
          task.stage = "awaiting_approval"
          task.role = "frontier"
          const visits = limits.milestoneReview ? input.plan.phases.length : (limits.finalReview ? 1 : 0)
          task.budgetShortfall = visits > limits.maxEscalations ? { required: visits, available: limits.maxEscalations } : null
          if (task.budgetShortfall) deps.notify?.(`Prewalk review budget is short: ${visits} mandatory visits, limit ${limits.maxEscalations}`)
          await persist(revising ? "plan-revised" : "plan-proposed", { eventId: input.eventId, reason: "human-plan-approval-required" })
          return { ok: true, proposalId: proposal.proposal.id, budgetShortfall: task.budgetShortfall }
        }
        if (input.action === "progress") {
          if (task.stage !== "cheap" || task.role !== "cheap") return { ok: false, reason: "progress-update-not-allowed-in-this-stage" }
          const phase = currentPhase()
          if (!phase || input.phaseId !== phase.id || !Array.isArray(input.todos)) return { ok: false, reason: "progress-must-target-current-phase" }
          if (input.todos.some((update) => !phase.todos.some((item) => item.id === update.id) ||
            !["pending", "in_progress", "ready", "completed"].includes(update.status))) {
            return { ok: false, reason: "invalid-todo-update" }
          }
          if (input.evidence !== undefined) {
            if (!Array.isArray(input.evidence) || input.evidence.some((path) => !phase.evidenceRequired?.includes(path))) return { ok: false, reason: "unplanned-artifact-evidence" }
            for (const path of input.evidence) {
              const absolute = resolve(task.workspace, path)
              try {
                const actual = realpathSync(absolute)
                if (!isPathWithin(actual, realpathSync(task.workspace)) || !lstatSync(actual).isFile()) return { ok: false, reason: "artifact-not-observed" }
              } catch { return { ok: false, reason: "artifact-not-observed" } }
            }
          }
          for (const update of input.todos) phase.todos.find((item) => item.id === update.id).status = update.status
          if (input.evidence !== undefined) task.phaseEvidence[phase.id] = { items: [...input.evidence], revision: task.sourceRevision, observed: true }
          if (typeof input.currentStep === "string") task.current_step = input.currentStep.slice(0, 500)
          if (Array.isArray(input.pending)) task.pending = input.pending.filter((item) => typeof item === "string").slice(0, 100)
          if (Array.isArray(input.decisions)) task.important_decisions.push(...input.decisions.filter((item) => typeof item === "string").map((reason) => ({ timestamp: now(), reason: reason.slice(0, 500) })))
          await persist("progress", { eventId: input.eventId, phaseId: phase.id })
          return { ok: true, phaseId: phase.id }
        }
        if (input.action === "propose") {
          if (!["hard", "soft"].includes(input.kind) || !isPlainObject(input.patch)) return { ok: false, reason: "invalid-proposal" }
          if (input.kind === "soft" && task.role !== "frontier") return { ok: false, reason: "soft-refinement-requires-frontier" }
          if (input.kind === "soft" && input.patch.expectedFiles !== undefined &&
            (!Array.isArray(input.patch.expectedFiles) || input.patch.expectedFiles.some((path) => typeof path !== "string" ||
              !isPathAllowed(path, task.hardContract.allowedPaths, task.hardContract.protectedPaths)))) {
            return { ok: false, reason: "soft-refinement-outside-hard-boundary" }
          }
          if (input.kind === "hard") {
            if (task.role === "cheap") {
              const route = await routeToFrontier("scope-expansion", { eventId: input.eventId, phaseId: task.currentPhaseId })
              return { ok: route.action === "review-pending", route: route.action, requiresHuman: false }
            }
            if (task.stage !== "frontier_review" || !task.initialApproval) return { ok: false, reason: "hard-proposal-requires-approved-plan-and-frontier-review" }
            if (Object.keys(input.patch).some((key) => !["outcome", "constraints", "allowedPaths", "protectedPaths"].includes(key)) ||
              validatePlan({ ...task.plan, hardContract: { ...task.hardContract, ...input.patch }, softPlan: task.softPlan }, task.workspace)) {
              return { ok: false, reason: "invalid-hard-boundary-proposal" }
            }
            const proposal = createProposal(task, { kind: "hard", patch: input.patch })
            task = proposal.state
            task.proposalResumeStage = task.stage
            task.stage = "awaiting_human_approval"
            task.role = "none"
            await persist("hard-proposal", { eventId: input.eventId, reason: "human-approval-required" })
            return { ok: true, proposalId: proposal.proposal.id, requiresHuman: true }
          }
          const proposal = createProposal(task, { kind: "soft", patch: input.patch })
          task = proposal.state
          await persist("soft-refinement", { eventId: input.eventId, reason: "frontier-soft-refinement" })
          return { ok: true, proposalId: proposal.proposal.id, version: task.softRevision }
        }
        if (input.action === "verdict") {
          if (task.stage !== "frontier_review" || task.role !== "frontier") return { ok: false, reason: "frontier-verdict-not-allowed-in-this-stage" }
          if (input.sourceRevision && input.sourceRevision !== task.sourceRevision) return { ok: false, reason: "stale-review-revision" }
          if (input.verdict === "needs-human") {
            task.humanQuestion = String(input.reason ?? "Frontier review needs a human decision").slice(0, 1000)
            const proposal = createProposal(task, { kind: "decision", patch: { question: task.humanQuestion } })
            task = proposal.state
            task.proposalResumeStage = task.stage
            task.stage = "awaiting_human_approval"
            task.role = "none"
            await persist("review-needs-human", { eventId: input.eventId, reason: task.humanQuestion })
            return { ok: true, needsHuman: true, proposalId: proposal.proposal.id }
          }
          const phaseId = input.phaseId ?? task.reviewPhaseId
          const phase = task.phases.find((item) => item.id === phaseId)
          if (!phase || phaseId !== task.reviewPhaseId) return { ok: false, reason: "review-phase-mismatch" }
          if (input.verdict === "continue") {
            task.stage = "cheap_pending"
            task.role = "cheap"
            const ok = await persist("review-continue", { eventId: input.eventId, phaseId, reason: input.reason ?? "continue-within-approved-scope" })
            return { ok, phaseId }
          }
          if (input.verdict === "pass") {
            if (!isPhaseReady(task, phase)) return { ok: false, reason: "phase-evidence-incomplete-or-stale" }
            if (task.reviewIncludesFinal && (phaseAt(phase.id) !== task.phases.length - 1 ||
              task.phases.slice(0, -1).some((earlier) => !task.completed.includes(earlier.id)))) {
              return { ok: false, reason: "prior-phases-not-complete" }
            }
            const key = `${phase.id}:${task.planRevision}:${task.sourceRevision}`
            if (task.reviewRecords[key]) return { ok: false, reason: "review-already-recorded" }
            task.reviewRecords[key] = { verdict: "pass", phaseId, planRevision: task.planRevision, sourceRevision: task.sourceRevision, timestamp: now() }
            task.completed.push(phase.id)
            const nextPhase = task.phases[phaseAt(phase.id) + 1]
            const lastPhasePassed = !nextPhase
            if (task.reviewIncludesFinal || lastPhasePassed) {
              const proposal = createProposal(task, { kind: "final", patch: { phaseId, sourceRevision: task.sourceRevision }, baseRevision: task.sourceRevision })
              task = proposal.state
              task.finalProposalId = proposal.proposal.id
              task.stage = "awaiting_final_approval"
              task.role = "none"
              await persist("final-review-passed", { eventId: input.eventId, reason: "human-completion-approval-required" })
              return { ok: true, finalProposalId: task.finalProposalId }
            }
            task.currentPhaseId = nextPhase.id
            task.stage = "cheap_pending"
            task.role = "cheap"
            await persist("phase-review-passed", { eventId: input.eventId, phaseId })
            return { ok: true, nextPhaseId: nextPhase.id }
          }
          if (input.verdict === "repair") {
            const ids = new Set(Array.isArray(input.pendingTodoIds) ? input.pendingTodoIds : phase.todos.filter((todo) => todo.status !== "ready" && todo.status !== "completed").map((todo) => todo.id))
            phase.todos = phase.todos.map((todo) => ids.has(todo.id) ? { ...todo, status: "pending" } : todo)
            task.pending = [...ids]
            task.stage = "cheap_pending"
            task.role = "cheap"
            task.reviewRecords[`${phase.id}:${task.planRevision}:${task.sourceRevision}`] = { verdict: "repair", timestamp: now() }
            await persist("phase-review-repair", { eventId: input.eventId, phaseId, reason: input.reason ?? "repair-required" })
            return { ok: true, phaseId }
          }
          return { ok: false, reason: "invalid-verdict" }
        }
        if (input.action === "finish") {
          if (task.stage !== "cheap") return { ok: false, reason: "finish-request-not-allowed-in-this-stage" }
          if (task.phases.some((phase) => !task.completed.includes(phase.id) || !isPhaseReady(task, phase))) {
            return { ok: false, reason: "phases-or-evidence-incomplete" }
          }
          if (limits.finalReview) {
            const decision = await routeToFrontier("final-review", { includeFinal: true, eventId: input.eventId })
            return { ok: decision.action !== "stopped", ...decision }
          }
          const proposal = createProposal(task, { kind: "final", patch: { sourceRevision: task.sourceRevision } })
          task = proposal.state
          task.finalProposalId = proposal.proposal.id
          task.stage = "awaiting_final_approval"
          task.role = "none"
          await persist("finish-awaiting-human", { eventId: input.eventId, reason: "final-review-disabled" })
          return { ok: true, proposalId: task.finalProposalId }
        }
        if (input.action === "cancel") return stop("cancelled", { eventId: input.eventId })
        return { ok: false, reason: "unknown-checkpoint-action" }
      })
    },
    async approve(proposalId, { baseRevision } = {}) {
      return serialize(async () => {
        if (!task || !proposalId) return { ok: false, reason: "proposal-not-found" }
        if (["stopped", "complete", "paused"].includes(task.stage)) return { ok: false, reason: "run-not-active" }
        const pending = task.proposals.find((proposal) => proposal.id === proposalId)
        if (!pending || pending.status !== "pending") return { ok: false, reason: "proposal-not-found" }
        let current
        try { current = await snapshot() } catch {
          await stop("worktree-snapshot-failed")
          return { ok: false, reason: "worktree-snapshot-failed" }
        }
        if (fingerprintSnapshot(current) !== task.sourceRevision) {
          await stop("worktree-changed-before-approval")
          return { ok: false, reason: "worktree-changed-before-approval" }
        }
        const expected = baseRevision ?? pending.baseRevision
        const result = approveProposal(task, proposalId, expected)
        if (!result.ok) return result
        const previousStage = task.proposalResumeStage
        task = result.state
        if (pending.kind === "hard" || pending.kind === "decision") {
          task.stage = previousStage
          task.role = previousStage?.includes("frontier") ? "frontier" : "cheap"
          delete task.proposalResumeStage
        }
        if (pending.kind === "final") task.role = "none"
        const ok = await persist("proposal-approved", { reason: pending.kind === "final" ? "human-completion-approved" : "human-proposal-approved" })
        return { ok, stage: task.stage }
      })
    },
    async rejectProposal(proposalId) {
      return serialize(async () => {
        if (!task) return { ok: false, reason: "proposal-not-found" }
        const proposal = task.proposals.find((item) => item.id === proposalId && item.status === "pending")
        if (!proposal) return { ok: false, reason: "proposal-not-found" }
        proposal.status = "rejected"
        return stop("proposal-rejected", { reason: "human-refused-proposal" })
      })
    },
    observeToolCall({ id, name, input = {} } = {}) {
      if (!task || task.stage === "idle") return undefined
      if (["stopped", "complete", "paused", "awaiting_human_approval", "awaiting_final_approval", "awaiting_approval"].includes(task.stage)) {
        if (name === "write" && isPlanPath(input.path) && ["awaiting_approval"].includes(task.stage)) {
          task.pendingTools[id] = { name, planPath: true }
          return undefined
        }
        return { block: true, reason: `Prewalk is paused in ${task.stage}; use its human command to continue.` }
      }
      if (task.stage.startsWith("frontier") && task.role === "frontier" &&
        !FRONTIER_TOOLS.has(name) && !(task.stage === "frontier_review" && name === "bash")) {
        return { block: true, reason: "The initial Frontier pass only permits discovery tools, its checkpoint tools, and the representative edit." }
      }
      if (task.stage === "frontier_review" && (name === "edit" || name === "write")) {
        return { block: true, reason: "Frontier review is for evidence and verdicts; return repairs to Cheap." }
      }
      if (name === "edit" || name === "write") {
        const resolved = capturePath(input.path)
        if (resolved.error) return { block: true, reason: resolved.error }
        if (isPlanPath(resolved.path)) {
          task.pendingTools[id] = { name, planPath: true, path: resolved.path }
          return undefined
        }
        if (task.hardContract && !isPathAllowed(resolved.path, task.hardContract.allowedPaths ?? [], task.hardContract.protectedPaths ?? [])) {
          return scheduleDeviation(id, resolved.path, name)
        }
        if (task.stage === "frontier_plan" || task.stage === "awaiting_approval") return { block: true, reason: `Write the plan and obtain explicit human approval before source edits (${PREWALK_PLAN_PATH}).` }
        if (task.stage === "frontier_initial") {
          if (!task.planWritten || !task.initialApproval) return { block: true, reason: "A human-approved plan is required before the representative source edit." }
          if (task.initialMutationApplied || Object.values(task.pendingTools).some((tool) => tool.initialMutation)) return { block: true, reason: "Only one successful representative source edit is allowed before Cheap handoff." }
          task.pendingTools[id] = { name, path: resolved.path, initialMutation: true }
          return undefined
        }
        task.pendingTools[id] = { name, path: resolved.path }
      } else {
        let checkId
        if (name === "bash" && typeof input.command === "string") {
          const observed = checkKey(input.command)
          for (const phase of task.phases) {
            const check = (phase.checks ?? []).find((item) => typeof item !== "string" &&
              resolve(task.workspace, item.cwd ?? ".") === task.workspace && checkKey(commandKey(item.command, item.args ?? [])) === observed)
            if (check) { checkId = check.id; break }
          }
        }
        task.pendingTools[id] = { name, checkId }
      }
      if (!["prewalk_checkpoint", "prewalk_validate"].includes(name)) {
        const signature = `${name}:${name === "bash" ? checkKey(input.command ?? "") : input.path ?? input.pattern ?? ""}`
        task.recentSignatures.push({ signature, revision: task.sourceRevision })
        task.recentSignatures = task.recentSignatures.slice(-limits.churnWindow)
      }
      return undefined
    },
    observeToolResult({ id, name, isError = false, exitCode } = {}) {
      if (!task) return
      const pending = task.pendingTools[id]
      if (!pending) return
      delete task.pendingTools[id]
      completedTools.push({ id, name: pending.name ?? name })
      if (pending.planPath && !isError) task.planWritten = true
      if (pending.initialMutation && !isError) {
        task.initialMutationApplied = true
        task.changed_files = [...new Set([...task.changed_files, pending.path])].sort()
        task.stage = "cheap_pending"
        task.role = "cheap"
        rememberDecision("initial-representative-edit-complete", { path: pending.path, toolId: id })
      } else if (pending.path && !isError) {
        task.changed_files = [...new Set([...task.changed_files, pending.path])].sort()
      }
      if (pending.checkId) {
        const current = task.validation_results[pending.checkId]
        // Tool-level isError describes the invocation, not the subprocess exit code.
        // Only an explicit host-reported integer exit code is validation evidence.
        const code = Number.isInteger(exitCode) ? exitCode : undefined
        const outcome = code === undefined ? "unknown" : code === 0 ? "passed" : "failed"
        const streak = outcome === "failed" ? (task.failureStreaks[pending.checkId] ?? 0) + 1 : 0
        task.validation_results[pending.checkId] = { status: outcome, revision: task.sourceRevision, observed: true, exitCode: code ?? null, timestamp: now() }
        if (outcome !== "unknown") task.failureStreaks[pending.checkId] = streak
        if (outcome === "failed") {
          task.failure_count += 1
          if (current?.status === "failed") task.retry_count += 1
        }
      }
      if (name === "prewalk_checkpoint" && isError) task.retry_count += 1
    },
    async validate(checkId, { toolCallId } = {}) {
      return serialize(async () => {
        if (!task || task.stage !== "cheap" || task.role !== "cheap") return { status: "unknown", reason: "validation-not-allowed-in-this-stage" }
        const found = findCheck(task, checkId)
        if (!found || typeof found.check.command !== "string") return { status: "unknown", reason: "unknown-check-id" }
        const check = found.check
        const cwd = resolve(task.workspace, check.cwd ?? ".")
        if (!isPathWithin(cwd, task.workspace)) return { status: "unknown", reason: "check-cwd-outside-workspace" }
        let realRoot, realCwd
        try { realRoot = realpathSync(task.workspace); realCwd = realpathSync(cwd) }
        catch { return { status: "unknown", reason: "check-cwd-unavailable" } }
        if (!isPathWithin(realCwd, realRoot)) return { status: "unknown", reason: "check-cwd-symlink-escape" }
        let result
        try {
          result = await (deps.runCommand
            ? deps.runCommand(check.command, check.args ?? [], { cwd, timeout: limits.commandTimeoutMs })
            : spawnSync(check.command, check.args ?? [], { cwd, encoding: "utf8", timeout: limits.commandTimeoutMs }))
        } catch (error) {
          result = { status: null, error }
        }
        const exitCode = result.status ?? result.exitCode ?? null
        const timedOut = result.timedOut === true || result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" && result.error
        const status = timedOut ? "timeout" : exitCode === 0 ? "passed" : Number.isInteger(exitCode) ? "failed" : "unknown"
        const old = task.validation_results[checkId]
        task.validation_results[checkId] = { status, revision: task.sourceRevision, exitCode, observed: true, timestamp: now(), phaseId: found.phase.id }
        if (status === "passed") task.failureStreaks[checkId] = 0
        if (status === "failed" || status === "timeout") {
          task.failure_count += 1
          task.failureStreaks[checkId] = (task.failureStreaks[checkId] ?? 0) + 1
          if (old?.status === "failed" || old?.status === "timeout") task.retry_count += 1
        }
        const streak = task.failureStreaks[checkId] ?? 0
        let route
        if ((status === "failed" || status === "timeout") && streak >= limits.failureThreshold) {
          route = await routeToFrontier("validation-threshold", { phaseId: found.phase.id, eventId: `validation:${checkId}:${task.failure_count}`, toolIds: [toolCallId ?? checkId], tools: toolCallId ? [{ id: toolCallId, name: "prewalk_validate" }] : [] }).then((decision) => decision.action === "review-pending" ? decision : undefined)
        }
        const output = [result.stdout, result.stderr, result.error?.message].filter((part) => typeof part === "string" && part.length).join("\n")
        await persist("validation-result", { toolIds: [toolCallId ?? checkId], tools: toolCallId ? [{ id: toolCallId, name: "prewalk_validate" }] : [], validationOutcome: { checkId, status, exitCode }, reason: route?.reason })
        return { status, exitCode, timedOut, checkId, phaseId: found.phase.id, revision: task.sourceRevision, route: route?.action,
          output: output.slice(0, limits.outputLimitChars), truncated: output.length > limits.outputLimitChars }
      })
    },
    async completeToolBatch({ eventId, toolIds = [] } = {}) {
      return serialize(async () => {
        if (!task) return { changedFiles: [] }
        if (eventId && task.seenEventIds.includes(eventId)) return { reason: "duplicate-event", changedFiles: task.changed_files }
        if (eventId) task.seenEventIds.push(eventId)
        const tools = completedTools.splice(0)
        const observedIds = [...new Set([...toolIds, ...tools.map((tool) => tool.id)])]
        let current
        try { current = await snapshot() } catch { return stop("worktree-snapshot-failed", { eventId, toolIds: observedIds, tools }) }
        const changed = changedSinceBaseline(task.baseline, current)
        const before = task.sourceRevision
        task.snapshot = { ...current }
        task.sourceRevision = fingerprintSnapshot(current)
        task.changed_files = [...new Set([...task.changed_files, ...changed])].sort()
        const outside = changed.find((path) => task.hardContract && !isPathAllowed(path, task.hardContract.allowedPaths ?? [], task.hardContract.protectedPaths ?? []))
        if (outside) {
          await routeToFrontier("deviation", { eventId, toolIds: observedIds, tools })
        } else if (task.softPlan?.expectedFiles?.length && changed.length > task.softPlan.expectedFiles.length * limits.scopeExpansionFactor) {
          await routeToFrontier("scope-expansion", { eventId, toolIds: observedIds, tools })
        } else {
          const repeated = task.recentSignatures.length >= limits.toolChurnThreshold && task.recentSignatures.slice(-limits.toolChurnThreshold).every((item) => item.signature === task.recentSignatures.at(-1)?.signature)
          if (repeated) await routeToFrontier("churn", { eventId, toolIds: observedIds, tools })
        }
        const phase = currentPhase()
        if (phase && task.stage === "cheap" && isPhaseReady(task, phase)) {
          const lastPhase = phaseAt(phase.id) === task.phases.length - 1
          const includeFinal = lastPhase && limits.finalReview
          const key = `${phase.id}:${task.planRevision}:${task.sourceRevision}`
          if (!task.reviewRecords[key] && !task.readyPhases.includes(key)) {
            task.readyPhases.push(key)
            if (limits.milestoneReview || includeFinal) {
              await routeToFrontier("phase-ready", { phaseId: phase.id, includeFinal, eventId, toolIds: observedIds, tools })
            } else {
              task.completed.push(phase.id)
              task.reviewRecords[key] = { verdict: "review-disabled", phaseId: phase.id, sourceRevision: task.sourceRevision }
              const nextPhase = task.phases[phaseAt(phase.id) + 1]
              if (nextPhase) task.currentPhaseId = nextPhase.id
              else {
                const proposal = createProposal(task, { kind: "final", patch: { phaseId: phase.id, sourceRevision: task.sourceRevision } })
                task = proposal.state
                task.finalProposalId = proposal.proposal.id
                task.stage = "awaiting_final_approval"
                task.role = "none"
              }
            }
          }
        }
        await persist("tool-batch-complete", { eventId, toolIds: observedIds, tools, changedFiles: changed, previousRevision: before })
        return { changedFiles: changed, revision: task.sourceRevision, routed: task.stage === "frontier_review_pending" }
      })
    },
    async turnStart({ eventId, model } = {}) {
      return serialize(async () => {
        if (!task || task.stage === "stopped" || task.stage === "complete") return { action: "none" }
        if (eventId && task.seenEventIds.includes(eventId)) return { action: "none", reason: "duplicate-event" }
        if (eventId) task.seenEventIds.push(eventId)
        const stopped = await stopForLimits(eventId)
        if (stopped) return stopped
        task.step_count += 1
        lastTurnStarted = Date.now()
        task.producingModel = model ?? (task.role === "frontier" ? task.frontierModel : task.cheapModel)
        const ok = await persist("turn-start", { eventId, producingModel: task.producingModel })
        return { action: ok ? "continue" : "stopped" }
      })
    },
    async turnEnd({ eventId, message } = {}) {
      return serialize(async () => {
        if (!task) return { action: "none" }
        if (message?.role === "assistant" && !(await recordUsageEntry(message))) return { action: "stopped", reason: task.stopReason }
        if (task.stage === "stopped") return { action: "stopped", reason: task.stopReason }
        if (task.stage !== "frontier_review_pending" && task.stage !== "cheap_pending") return { action: "none" }
        const targetRef = task.stage === "frontier_review_pending" ? task.frontierModel : task.cheapModel
        const previousModel = task.role === "frontier" ? task.cheapModel : task.frontierModel
        const target = deps.findModel ? await deps.findModel(targetRef) : targetRef
        if (!target) return stop("model-unavailable", { eventId, previousModel })
        let switched = false
        try { switched = deps.setModel ? await deps.setModel(target, targetRef) : true } catch { switched = false }
        if (!switched) return stop("model-switch-failed", { eventId, previousModel })
        task.stage = targetRef === task.frontierModel ? "frontier_review" : "cheap"
        task.role = targetRef === task.frontierModel ? "frontier" : "cheap"
        task.previousModel = previousModel
        task.currentModel = targetRef
        task.switchIntent = undefined
        const persisted = await persist("model-switched", { eventId, previousModel, currentModel: targetRef, reason: task.lastEscalationReason, latencyMs: lastTurnStarted ? Date.now() - lastTurnStarted : undefined })
        if (!persisted) return { action: "stopped", reason: task.stopReason }
        deps.sendMessage?.({ role: task.role, model: targetRef, reason: task.lastEscalationReason, phaseId: task.reviewPhaseId, phaseIds: task.reviewPhaseIds ?? [], state: safeClone(task) })
        deps.notify?.(`Prewalk switched to ${targetRef}`)
        return { action: "switched", model: targetRef, stage: task.stage }
      })
    },
    async beforeSettle(input = {}) { return this.turnEnd(input) },
    agentSettled() { return this.status() },
    async modelSelected(modelRef) {
      if (!task || !ROUTABLE_STAGES.has(task.stage)) return { ok: true }
      const expected = task.role === "frontier" ? task.frontierModel : task.role === "cheap" ? task.cheapModel : undefined
      if (expected && modelRef === expected) return { ok: true }
      return stop("manual-switch", { previousModel: expected, currentModel: modelRef })
    },
    recordUsage(message) { return recordUsageEntry(message) },
    reviewContext(evidence = {}) {
      if (!task) return { ok: false, reason: "no-active-run" }
      const context = buildReviewContext({ state: task, diff: evidence.diff ?? "", failures: evidence.failures ?? [], budgetChars: limits.contextBudgetChars })
      if (!context.ok) markStopSync("mandatory-context-exceeds-budget")
      return context
    },
    async cancel() { return stop("cancelled") },
    async pause(reason = "session-identity-changed") { return stop(reason) },
    get sessionIdentity() { return task ? { runId: task.runId, sessionId: task.sessionId, workspace: task.workspace } : undefined },
  }
}
