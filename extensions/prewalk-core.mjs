import { isAbsolute, relative, resolve, sep } from "node:path"

export const PREWALK_PLAN_PATH = ".temp-local/workflow-plan.md"
export const PREWALK_STATE_ENTRY = "prewalk-state"

export const ROUTING_DEFAULTS = Object.freeze({
  failureThreshold: 2,
  toolChurnThreshold: 6,
  churnWindow: 20,
  maxEscalations: 8,
  maxRetries: 6,
  maxSteps: 100,
  milestoneReview: true,
  finalReview: true,
  contextBudgetChars: 24000,
  outputLimitChars: 4000,
  commandTimeoutMs: 120000,
  scopeExpansionFactor: 2,
})

export function resolveRoutingConfig(config = {}) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Routing config must be an object")
  const resolved = { ...ROUTING_DEFAULTS, ...config }
  for (const key of Object.keys(ROUTING_DEFAULTS)) {
    const value = resolved[key]
    if (typeof ROUTING_DEFAULTS[key] === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
    } else if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer`)
    }
  }
  return resolved
}

const FRONTIER_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"])

function validateModelRef(value) {
  const [provider, ...modelParts] = value.split("/")
  if (/\s/.test(value) || !provider || modelParts.length === 0 || modelParts.some((part) => !part)) {
    throw new Error(`Expected a provider/model ID, received "${value}"`)
  }
  return value
}

function splitPath(path) {
  const parts = path.replaceAll("\\", "/").split("/")
  if (parts[0] === "") return []
  const normalized = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (normalized.length === 0) return []
      normalized.pop()
      continue
    }
    normalized.push(part)
  }
  return normalized
}

export function parsePrewalkConfig(settings) {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("Local Prewalk config must be a JSON object")
  }
  const oldFrontier = settings.first_model
  const newFrontier = settings.frontier_model
  const oldCheap = settings.second_model
  const newCheap = settings.cheap_model
  if (oldFrontier !== undefined && newFrontier !== undefined && oldFrontier !== newFrontier) {
    throw new Error("first_model and frontier_model conflict")
  }
  if (oldCheap !== undefined && newCheap !== undefined && oldCheap !== newCheap) {
    throw new Error("second_model and cheap_model conflict")
  }
  const firstModel = oldFrontier ?? newFrontier
  const secondModel = oldCheap ?? newCheap
  if (typeof firstModel !== "string" || firstModel.trim() === "") {
    throw new Error("Local Prewalk config requires first_model/frontier_model as a provider/model ID")
  }
  if (typeof secondModel !== "string" || secondModel.trim() === "") {
    throw new Error("Local Prewalk config requires second_model/cheap_model as a provider/model ID")
  }
  return { firstModel: validateModelRef(firstModel.trim()), secondModel: validateModelRef(secondModel.trim()) }
}

export function parsePrewalkArgs(args, config) {
  const parts = args.trim() === "" ? [] : args.trim().split(/\s+/)
  if (parts.length > 2) throw new Error("Prewalk expects zero, one, or two model IDs")
  if (parts.length === 0) {
    if (!config) throw new Error("Prewalk needs a local Prewalk config (prewalk.json in the harness directory) or explicit model arguments")
    return { firstModel: config.firstModel, secondModel: config.secondModel }
  }
  if (parts.length === 1) {
    if (!config) throw new Error("Prewalk needs a local Prewalk config (prewalk.json in the harness directory) or explicit model arguments")
    return { firstModel: config.firstModel, secondModel: validateModelRef(parts[0]) }
  }
  return { firstModel: validateModelRef(parts[0]), secondModel: validateModelRef(parts[1]) }
}

export function isScratchPath(path) {
  return splitPath(path)[0] === ".temp-local"
}

export function isPlanPath(path) {
  const segments = splitPath(path)
  return segments.at(-2) === ".temp-local" && segments.at(-1) === "workflow-plan.md"
}

function isMutation(toolName, input) {
  return (toolName === "edit" || toolName === "write") && typeof input.path === "string" && input.path.trim() !== ""
}

export function normalizeRepoPath(path) {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) throw new Error("path must be a non-empty repository-relative path")
  const value = path.replaceAll("\\", "/")
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) throw new Error("absolute path is outside the workspace")
  const parts = []
  for (const part of value.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.length) throw new Error("path traversal is outside the workspace")
      parts.pop()
    } else parts.push(part)
  }
  if (!parts.length) throw new Error("path must identify a file inside the workspace")
  return parts.join("/")
}

export function isPathWithin(candidate, root) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

function matchesPath(path, entry) {
  if (typeof entry !== "string" || entry === "") return false
  let normalized
  try { normalized = normalizeRepoPath(entry.endsWith("/") ? entry.slice(0, -1) : entry) } catch { return false }
  return entry.endsWith("/") ? path === normalized || path.startsWith(`${normalized}/`) : path === normalized
}

export function isPathAllowed(path, allowedPaths = [], protectedPaths = []) {
  let normalized
  try { normalized = normalizeRepoPath(path) } catch { return false }
  if (protectedPaths.some((item) => matchesPath(normalized, item))) return false
  return allowedPaths.length === 0 || allowedPaths.some((item) => matchesPath(normalized, item))
}

export function createTaskState({ runId, sessionId, workspace, goal, frontierModel, cheapModel, config = ROUTING_DEFAULTS, baseline = {} }) {
  const limits = resolveRoutingConfig(config)
  return {
    version: 1,
    stateRevision: 0,
    runId,
    sessionId,
    workspace: resolve(workspace),
    stage: "frontier_plan",
    role: "frontier",
    frontierModel,
    cheapModel,
    currentModel: frontierModel,
    previousModel: null,
    producingModel: null,
    goal,
    plan: null,
    hardContract: null,
    softPlan: null,
    planRevision: 0,
    hardRevision: 0,
    softRevision: 0,
    phases: [],
    currentPhaseId: null,
    completed: [],
    current_step: null,
    pending: [],
    changed_files: [],
    validation_results: {},
    phaseEvidence: {},
    failure_count: 0,
    failureStreaks: {},
    escalation_count: 0,
    retry_count: 0,
    step_count: 0,
    important_decisions: [],
    sourceRevision: fingerprintSnapshot(baseline),
    baseline: { ...baseline },
    snapshot: { ...baseline },
    planWritten: false,
    initialMutationApplied: false,
    initialApproval: null,
    proposals: [],
    reviewRecords: {},
    readyPhases: [],
    reviewIncludesFinal: false,
    finalProposalId: null,
    pendingTools: {},
    checkInvocations: {},
    seenEventIds: [],
    recentSignatures: [],
    usage: [],
    lastEscalationReason: null,
    stopReason: null,
    config: limits,
    maxEscalations: limits.maxEscalations,
    maxRetries: limits.maxRetries,
    maxSteps: limits.maxSteps,
  }
}

export function fingerprintSnapshot(snapshot = {}) {
  const entries = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
}

export function changedSinceBaseline(baseline = {}, current = {}) {
  const changed = new Set()
  for (const path of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (isScratchPath(path)) continue
    if (baseline[path] !== current[path]) {
      try { changed.add(normalizeRepoPath(path)) } catch { changed.add(path.replaceAll("\\", "/")) }
    }
  }
  return [...changed].sort()
}

export function isPhaseReady(state, phase) {
  if (!phase || !Array.isArray(phase.todos) || phase.todos.length === 0) return false
  if (!phase.todos.every((todo) => todo.status === "ready" || todo.status === "completed")) return false
  const checks = (phase.checks ?? []).filter((check) => typeof check === "string" || check.required !== false)
  if (checks.length) {
    return checks.every((check) => {
      const id = typeof check === "string" ? check : check.id
      const result = state.validation_results?.[id]
      return result?.status === "passed" && result.revision === state.sourceRevision
    })
  }
  const evidence = state.phaseEvidence?.[phase.id]
  return Array.isArray(phase.evidenceRequired) && phase.evidenceRequired.length > 0 &&
    phase.evidenceRequired.every((item) => evidence?.items?.includes(item)) && evidence.revision === state.sourceRevision
}

export function decideRoute(state, event, config = state.config ?? ROUTING_DEFAULTS) {
  const limits = resolveRoutingConfig(config)
  if (["cancel", "aborted", "persistence-failed", "model-switch-failed", "manual-switch", "identity-mismatch"].includes(event.type)) {
    return { action: "stop", reason: event.type }
  }
  if (state.step_count >= limits.maxSteps || state.retry_count >= limits.maxRetries) {
    return { action: "stop", reason: "limit-reached" }
  }
  const needsNewVisit = (event.type === "phase-ready" && (limits.milestoneReview || (event.final && limits.finalReview))) ||
    (event.type === "validation-failed" && event.recognized === true && event.streak >= limits.failureThreshold) ||
    ["deviation", "churn", "scope-expansion", "plan-revision"].includes(event.type) ||
    (event.type === "finish-requested" && limits.finalReview)
  if (needsNewVisit && state.escalation_count >= limits.maxEscalations) return { action: "stop", reason: "limit-reached" }
  if (event.type === "phase-ready") {
    if (!limits.milestoneReview && !(event.final && limits.finalReview)) return { action: "continue", reason: "review-disabled" }
    return { action: "review", reason: "phase-ready", phaseId: event.phaseId, includeFinal: Boolean(event.final && limits.finalReview) }
  }
  if (event.type === "validation-failed") {
    if (event.recognized !== true) return { action: "continue", reason: "unknown-validation" }
    return event.streak >= limits.failureThreshold ? { action: "review", reason: "validation-threshold", checkId: event.checkId } : { action: "continue", reason: "validation-repair" }
  }
  if (["deviation", "churn", "scope-expansion", "plan-revision"].includes(event.type)) return { action: "review", reason: event.type }
  if (event.type === "finish-requested") return limits.finalReview ? { action: "review", reason: "final-review", includeFinal: true } : { action: "human-approval", reason: "final-review-disabled" }
  if (event.type === "frontier-pass") return { action: event.includeFinal ? "human-approval" : "cheap", reason: "frontier-pass" }
  if (event.type === "frontier-repair") return { action: "cheap", reason: "frontier-repair" }
  return { action: "continue", reason: event.type ?? "no-trigger" }
}

export function reduceTaskState(state, event, config = state.config ?? ROUTING_DEFAULTS) {
  if (event.id && state.seenEventIds.includes(event.id)) return { state, decision: { action: "none", reason: "duplicate-event" } }
  const next = structuredClone(state)
  if (event.id) next.seenEventIds.push(event.id)
  let routeEvent = event
  if (event.type === "turn") {
    next.step_count += 1
  } else if (event.type === "retry") {
    next.retry_count += 1
    routeEvent = { ...event, type: "retry-limit" }
  } else if (event.type === "validation-failed" && event.recognized === true) {
    next.failure_count += 1
    next.failureStreaks[event.checkId] = (next.failureStreaks[event.checkId] ?? 0) + 1
    routeEvent = { ...event, streak: next.failureStreaks[event.checkId] }
  } else if (event.type === "validation-passed") {
    next.failureStreaks[event.checkId] = 0
  }
  const decision = decideRoute(next, routeEvent, config)
  if (decision.action === "review") {
    next.escalation_count += 1
    next.lastEscalationReason = decision.reason
    next.stage = "frontier_review_pending"
  } else if (decision.action === "stop") {
    next.stage = "stopped"
    next.stopReason = decision.reason
  }
  return { state: next, decision }
}

export function createProposal(state, { kind, patch, baseRevision = state.sourceRevision, id }) {
  if (!(["hard", "soft", "initial", "final", "decision", "plan"].includes(kind))) throw new Error("Unknown proposal kind")
  const proposal = {
    id: id ?? `proposal-${state.proposals.length + 1}-${String(baseRevision).slice(0, 12)}`,
    kind,
    patch: structuredClone(patch ?? {}),
    baseRevision,
    hardRevision: state.hardRevision,
    status: kind === "soft" ? "accepted" : "pending",
  }
  const next = structuredClone(state)
  next.proposals.push(proposal)
  if (kind === "soft") {
    next.softPlan = { ...(next.softPlan ?? {}), ...structuredClone(patch ?? {}) }
    next.softRevision += 1
  }
  return { state: next, proposal }
}

export function approveProposal(state, proposalId, baseRevision = state.sourceRevision) {
  const proposal = state.proposals.find((item) => item.id === proposalId)
  if (!proposal || proposal.status !== "pending") return { ok: false, reason: "proposal-not-pending" }
  if (baseRevision !== proposal.baseRevision || state.sourceRevision !== proposal.baseRevision) return { ok: false, reason: "stale-proposal" }
  const next = structuredClone(state)
  const target = next.proposals.find((item) => item.id === proposalId)
  target.status = "approved"
  if (target.kind === "hard") {
    next.hardContract = { ...(next.hardContract ?? {}), ...structuredClone(target.patch) }
    next.hardRevision += 1
  } else if (target.kind === "initial") {
    next.hardContract = structuredClone(target.patch.hardContract)
    next.softPlan = structuredClone(target.patch.softPlan)
    next.phases = structuredClone(target.patch.phases)
    next.plan = structuredClone(target.patch)
    next.planRevision += 1
    next.currentPhaseId = next.phases[0]?.id ?? null
    next.initialApproval = { proposalId, baseRevision }
    next.stage = "frontier_initial"
  } else if (target.kind === "plan") {
    const revised = structuredClone(target.patch)
    if (JSON.stringify(revised.hardContract) !== JSON.stringify(next.hardContract)) next.hardRevision += 1
    next.hardContract = revised.hardContract
    next.softPlan = revised.softPlan
    next.phases = revised.phases.map((phase) => {
      const previous = next.phases.find((item) => item.id === phase.id)
      if (next.completed.includes(phase.id)) return phase
      return { ...phase, todos: phase.todos.map((todo) => {
        const old = previous?.todos.find((item) => item.id === todo.id)
        const { status: _newStatus, ...definition } = todo
        const { status: _oldStatus, ...oldDefinition } = old ?? {}
        return { ...todo, status: old && JSON.stringify(definition) === JSON.stringify(oldDefinition) ? old.status : "pending" }
      }) }
    })
    const retainedChecks = new Set(next.phases.flatMap((phase) => (phase.checks ?? []).map((check) => typeof check === "string" ? check : check.id)))
    for (const id of Object.keys(next.validation_results)) {
      if (!retainedChecks.has(id)) {
        delete next.validation_results[id]
        delete next.failureStreaks[id]
      }
    }
    for (const phase of next.phases) {
      if (next.completed.includes(phase.id)) continue
      const prior = state.phases.find((item) => item.id === phase.id)
      for (const check of phase.checks ?? []) {
        const id = typeof check === "string" ? check : check.id
        const old = prior?.checks?.find((item) => (typeof item === "string" ? item : item.id) === id)
        if (JSON.stringify(old) !== JSON.stringify(check)) {
          delete next.validation_results[id]
          delete next.failureStreaks[id]
        }
      }
      if (JSON.stringify(prior?.evidenceRequired) !== JSON.stringify(phase.evidenceRequired)) delete next.phaseEvidence[phase.id]
    }
    next.plan = { ...revised, phases: structuredClone(next.phases) }
    next.planRevision += 1
    next.readyPhases = []
    next.reviewIncludesFinal = false
    next.revisionConfirmationPending = true
  } else if (target.kind === "final") {
    next.stage = "complete"
  }
  return { ok: true, state: next }
}

export function buildReviewContext({ state, diff = "", failures = [], budgetChars = state?.config?.contextBudgetChars ?? ROUTING_DEFAULTS.contextBudgetChars } = {}) {
  if (!state) return { ok: false, reason: "missing-state" }
  const currentPlan = state.plan
    ? { ...state.plan, hardContract: state.hardContract, softPlan: state.softPlan, phases: state.phases }
    : { softPlan: state.softPlan, phases: state.phases }
  const mandatory = [
    `Goal: ${state.goal ?? ""}`,
    `Hard contract: ${JSON.stringify(state.hardContract ?? {})}`,
    `Plan: ${JSON.stringify(currentPlan)}`,
    `Completed phases: ${JSON.stringify(state.completed ?? [])}`,
    `Current phase/step: ${state.currentPhaseId ?? "none"} / ${state.current_step ?? "none"}`,
    `Pending work: ${JSON.stringify(state.pending ?? [])}`,
    `Important decisions: ${JSON.stringify(state.important_decisions ?? [])}`,
    `Changed paths: ${JSON.stringify(state.changed_files ?? [])}`,
    `Validation results: ${JSON.stringify(state.validation_results ?? {})}`,
  ].join("\n")
  if (mandatory.length > budgetChars) return { ok: false, reason: "mandatory-context-exceeds-budget" }
  const optional = [
    `Routing/deviations: ${JSON.stringify({ lastEscalationReason: state.lastEscalationReason, proposals: state.proposals ?? [] })}`,
    `Failures: ${JSON.stringify(failures)}`,
    `Diff/reference: ${diff}`,
  ].join("\n")
  const available = Math.max(0, budgetChars - mandatory.length - 1)
  const marker = "\n[Optional evidence truncated]"
  let tail = optional
  if (optional.length > available) {
    const markerText = marker.slice(0, available)
    tail = `${optional.slice(0, Math.max(0, available - markerText.length))}${markerText}`
  }
  return { ok: true, text: `${mandatory}\n${tail}`, truncated: tail !== optional }
}

export function createPrewalkState() {
  let currentStage = "idle"
  let config
  let planWritten = false
  let planApproved = false
  let codeMutationApplied = false
  const pendingPlans = new Set()
  let pendingCodeMutation

  return {
    arm(nextConfig) {
      currentStage = "frontier"
      config = nextConfig
      planWritten = false
      planApproved = false
      codeMutationApplied = false
      pendingPlans.clear()
      pendingCodeMutation = undefined
    },
    disarm() {
      currentStage = "idle"
      config = undefined
      planWritten = false
      planApproved = false
      codeMutationApplied = false
      pendingPlans.clear()
      pendingCodeMutation = undefined
    },
    finish() { this.disarm() },
    stage() { return currentStage },
    config() { return config },
    approvePlan() {
      if (!planWritten || currentStage !== "frontier") return false
      planApproved = true
      return true
    },
    observeToolCall(toolCallId, toolName, input) {
      if (currentStage !== "frontier") return undefined
      if (!FRONTIER_ALLOWED_TOOLS.has(toolName)) {
        return { block: true, reason: "Prewalk frontier pass permits only read, grep, find, ls, edit, and write tools." }
      }
      if (!isMutation(toolName, input)) return undefined
      if (isScratchPath(input.path)) {
        if (isPlanPath(input.path)) pendingPlans.add(toolCallId)
        return undefined
      }
      if (!planWritten || !planApproved) {
        return { block: true, reason: `Prewalk requires a successfully written and human-approved plan file first (${PREWALK_PLAN_PATH}).` }
      }
      if (codeMutationApplied || pendingCodeMutation) {
        return { block: true, reason: "Prewalk permits one code mutation before switching to the worker model." }
      }
      pendingCodeMutation = toolCallId
      return undefined
    },
    observeToolResult(toolCallId, isError) {
      if (pendingPlans.delete(toolCallId)) {
        if (!isError) planWritten = true
        return
      }
      if (pendingCodeMutation === toolCallId) {
        pendingCodeMutation = undefined
        if (!isError) codeMutationApplied = true
      }
    },
    readyToHandoff() { return currentStage === "frontier" && codeMutationApplied },
    beginHandoff() {
      if (!this.readyToHandoff()) return false
      currentStage = "handoff"
      return true
    },
    completeHandoff(success) { currentStage = success ? "worker" : "idle" },
  }
}
