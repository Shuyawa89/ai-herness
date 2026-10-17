import assert from "node:assert/strict"
import test from "node:test"
import * as core from "../extensions/prewalk-core.mjs"

const config = core.resolveRoutingConfig({ milestoneReview: true, finalReview: true })

function state(overrides = {}) {
  return {
    version: 1,
    stage: "cheap",
    role: "cheap",
    runId: "run-1",
    sessionId: "session-1",
    workspace: "/repo",
    goal: "Implement routing",
    planRevision: 1,
    softRevision: 0,
    hardRevision: 0,
    lastEscalationReason: null,
    sourceRevision: "rev-1",
    hardContract: { outcome: "working feature", constraints: ["No rollback"], allowedPaths: ["src/"], protectedPaths: ["package.json"] },
    softPlan: { expectedFiles: ["src/a.mjs"], steps: ["Implement"] },
    phases: [{ id: "phase-1", todos: [{ id: "todo-1", status: "ready" }], checks: ["test-1"], evidence: [] }],
    validation_results: { "test-1": { status: "passed", revision: "rev-1" } },
    failure_count: 0,
    failureStreaks: {},
    escalation_count: 0,
    retry_count: 0,
    step_count: 0,
    maxSteps: 100,
    changed_files: [],
    proposals: [],
    reviewRecords: {},
    seenEventIds: [],
    ...overrides,
  }
}

test("routing configuration validates limits and retains safe review defaults", () => {
  assert.equal(typeof core.resolveRoutingConfig, "function")
  assert.equal(config.failureThreshold, 2)
  assert.equal(config.maxEscalations, 8)
  assert.equal(config.milestoneReview, true)
  assert.equal(config.finalReview, true)
  for (const value of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => core.resolveRoutingConfig({ failureThreshold: value }), /failureThreshold/)
  }
  assert.throws(() => core.resolveRoutingConfig({ milestoneReview: "yes" }), /milestoneReview/)
})

test("route decisions are deterministic, honor disabled review, and coalesce final review", () => {
  assert.deepEqual(core.decideRoute(state(), { type: "phase-ready", phaseId: "phase-1", final: true }, config), {
    action: "review",
    reason: "phase-ready",
    phaseId: "phase-1",
    includeFinal: true,
  })
  assert.equal(core.decideRoute(state(), { type: "phase-ready", phaseId: "phase-1" }, { ...config, milestoneReview: false }).action, "continue")
  assert.equal(core.decideRoute(state({ stage: "cheap", escalation_count: 8 }), { type: "phase-ready", phaseId: "phase-1" }, config).action, "stop")
  assert.equal(core.decideRoute(state({ retry_count: 6 }), { type: "no-trigger" }, config).action, "stop")
  assert.equal(core.decideRoute(state({ step_count: 100 }), { type: "turn" }, config).action, "stop")
  assert.equal(core.decideRoute(state(), { type: "validation-failed", checkId: "t", streak: 1 }, config).action, "continue")
  assert.equal(core.decideRoute(state(), { type: "validation-failed", checkId: "t", streak: 2, recognized: true }, config).action, "review")
  assert.equal(core.decideRoute(state(), { type: "unknown-tool-error" }, config).action, "continue")
})

test("task state reducer deduplicates stable events and never accepts caller counters", () => {
  assert.equal(typeof core.createTaskState, "function")
  assert.equal(typeof core.reduceTaskState, "function")
  const initial = core.createTaskState({ runId: "r", sessionId: "s", workspace: "/repo", goal: "g", config })
  const first = core.reduceTaskState(initial, { id: "e1", type: "turn", stepCount: 999 }, config)
  assert.equal(first.state.step_count, 1)
  assert.equal(first.decision.action, "continue")
  const duplicate = core.reduceTaskState(first.state, { id: "e1", type: "turn", stepCount: 999 }, config)
  assert.equal(duplicate.state, first.state)
  assert.equal(duplicate.decision.reason, "duplicate-event")
  assert.equal(initial.step_count, 0)
  assert.equal(initial.seenEventIds.length, 0)
})

test("path normalization rejects traversal and validates symlink-resolved containment", () => {
  assert.equal(core.normalizeRepoPath("src\\lib\\..\\main.mjs"), "src/main.mjs")
  assert.throws(() => core.normalizeRepoPath("../../secret"), /outside|traversal/i)
  assert.equal(core.isPathAllowed("src/new.mjs", ["src/"], []), true)
  assert.equal(core.isPathAllowed("package.json", ["src/"], ["package.json"]), false)
  assert.equal(core.isPathAllowed("README.md", [], []), true)
  assert.equal(core.isPathWithin("/repo/src/a", "/repo"), true)
  assert.equal(core.isPathWithin("/repository/a", "/repo"), false)
})

test("proposal approval binds exact proposal and revision; hard changes need human authority", () => {
  assert.equal(typeof core.createProposal, "function")
  assert.equal(typeof core.approveProposal, "function")
  const original = state({ proposals: [] })
  const proposal = core.createProposal(original, { kind: "hard", baseRevision: "rev-1", patch: { allowedPaths: ["src/", "tests/"] } })
  assert.equal(proposal.state.proposals[0].status, "pending")
  assert.equal(proposal.state.hardContract.allowedPaths.includes("tests/"), false)
  const stale = core.approveProposal(proposal.state, proposal.proposal.id, "rev-0")
  assert.equal(stale.ok, false)
  const approved = core.approveProposal(proposal.state, proposal.proposal.id, "rev-1")
  assert.equal(approved.ok, true)
  assert.equal(approved.state.hardContract.allowedPaths.includes("tests/"), true)
  assert.equal(core.approveProposal(approved.state, proposal.proposal.id, "rev-1").ok, false)
})

test("plan revisions reset changed TODOs and remove obsolete validation evidence", () => {
  const original = state({
    completed: [], phaseEvidence: {}, readyPhases: [],
    phases: [{ id: "phase-1", todos: [
      { id: "same", text: "Keep implemented work", status: "ready" },
      { id: "changed", text: "Old requirement", status: "ready" },
    ], checks: ["test-1"] }],
  })
  const revised = {
    hardContract: original.hardContract, softPlan: original.softPlan,
    phases: [{ id: "phase-1", todos: [
      { id: "same", text: "Keep implemented work", status: "pending" },
      { id: "changed", text: "New requirement", status: "ready" },
      { id: "new", text: "Unimplemented work", status: "completed" },
    ], checks: ["test-2"] }],
  }
  const proposed = core.createProposal(original, { kind: "plan", patch: revised })
  const approved = core.approveProposal(proposed.state, proposed.proposal.id)
  assert.equal(approved.ok, true)
  assert.deepEqual(approved.state.phases[0].todos.map((todo) => todo.status), ["ready", "pending", "pending"])
  assert.equal(approved.state.validation_results["test-1"], undefined)
  assert.equal(original.validation_results["test-1"].status, "passed", "input state remains immutable")
})

test("review context preserves mandatory contract and truncates optional evidence only", () => {
  assert.equal(typeof core.buildReviewContext, "function")
  const full = core.buildReviewContext({ state: state(), diff: "x".repeat(500), failures: ["failure"], budgetChars: 1000 })
  assert.equal(full.ok, true)
  assert.match(full.text, /Implement routing/)
  assert.match(full.text, /No rollback/)
  assert.match(full.text, /Validation results/)
  assert.match(full.text, /lastEscalationReason/)
  const tooSmall = core.buildReviewContext({ state: state({ goal: "g".repeat(2000) }), budgetChars: 100 })
  assert.equal(tooSmall.ok, false)
  assert.equal(tooSmall.reason, "mandatory-context-exceeds-budget")
  const fullEvidence = core.buildReviewContext({ state: state(), budgetChars: 100000 }).text
  const budget = fullEvidence.indexOf("Changed paths:") + 45
  const evidence = core.buildReviewContext({ state: state(), diff: "x".repeat(10000), budgetChars: budget })
  assert.equal(evidence.ok, false, "required validation evidence must not be silently truncated")
  assert.equal(evidence.reason, "mandatory-context-exceeds-budget")
})

test("all core route events and reducer counters obey terminal, retry, and evidence rules", () => {
  const s = state()
  assert.equal(core.decideRoute(s, { type: "cancel" }).action, "stop")
  assert.equal(core.decideRoute(s, { type: "finish-requested" }, { ...config, finalReview: false }).action, "human-approval")
  assert.equal(core.decideRoute(s, { type: "frontier-pass", includeFinal: false }).action, "cheap")
  assert.equal(core.decideRoute(s, { type: "frontier-pass", includeFinal: true }).action, "human-approval")
  assert.equal(core.decideRoute(s, { type: "frontier-repair" }).action, "cheap")
  const failed = core.reduceTaskState(s, { id: "fail", type: "validation-failed", checkId: "test-1", recognized: true }, config)
  assert.equal(failed.state.failure_count, 1)
  assert.equal(failed.decision.action, "continue")
  const passed = core.reduceTaskState(failed.state, { id: "pass", type: "validation-passed", checkId: "test-1" }, config)
  assert.equal(passed.state.failureStreaks["test-1"], 0)
  const retry = core.reduceTaskState(passed.state, { id: "retry", type: "retry" }, config)
  assert.equal(retry.state.retry_count, 1)
  assert.equal(retry.decision.action, "continue")
  const escalated = core.reduceTaskState(s, { id: "scope", type: "scope-expansion" }, config)
  assert.equal(escalated.decision.action, "review")
  assert.equal(escalated.state.stage, "frontier_review_pending")
  const stopped = core.reduceTaskState(state({ step_count: 100 }), { id: "at-limit", type: "turn" }, config)
  assert.equal(stopped.decision.action, "stop")
  const soft = core.createProposal(s, { kind: "soft", patch: { steps: ["refine"] } })
  assert.equal(soft.state.softRevision, 1)
  assert.deepEqual(soft.state.softPlan.steps, ["refine"])
  assert.throws(() => core.createProposal(s, { kind: "invalid" }), /Unknown proposal/)
})

test("the last permitted escalation can run its Frontier review before stopping further visits", () => {
  const current = state({ escalation_count: 1, stage: "frontier_review" })
  const limits = { ...config, maxEscalations: 1 }
  assert.equal(core.decideRoute(current, { type: "limit-check" }, limits).action, "continue")
  assert.equal(core.decideRoute({ ...current, stage: "cheap" }, { type: "phase-ready", phaseId: "phase-1" }, limits).action, "stop")
})

test("fresh phase evidence and scope deltas use stable normalized revisions", () => {
  assert.equal(typeof core.isPhaseReady, "function")
  const s = state()
  assert.equal(core.isPhaseReady(s, s.phases[0]), true)
  assert.equal(core.isPhaseReady(state({ validation_results: { "test-1": { status: "passed", revision: "old" } } }), s.phases[0]), false)
  assert.equal(core.isPhaseReady(state({ validation_results: { "test-1": { status: "unknown", revision: "rev-1" } } }), s.phases[0]), false)
  assert.equal(core.isPhaseReady(s, null), false)
  assert.equal(core.isPhaseReady(s, { id: "empty", todos: [], checks: [] }), false)
  assert.equal(core.isPhaseReady(s, { id: "evidence", todos: [{ id: "t", status: "ready" }], checks: [], evidenceRequired: ["artifact"] }), false)
  assert.equal(core.isPhaseReady(state({ phaseEvidence: { evidence: { items: ["artifact"], revision: "rev-1" } } }), { id: "evidence", todos: [{ id: "t", status: "ready" }], checks: [], evidenceRequired: ["artifact"] }), true)
  assert.deepEqual(core.changedSinceBaseline({ "src/a": "old", "src/b": "same" }, { "src/a": "new", "src/b": "same", "src/c": "new" }), ["src/a", "src/c"])
  assert.deepEqual(core.changedSinceBaseline({ "src/a": "old" }, { "src/a": "old" }), [])
})
