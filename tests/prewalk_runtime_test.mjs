import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildBoundedReviewMessages, captureGitSnapshot, createPrewalkRuntime } from "../extensions/prewalk-runtime.mjs"
import { resolveRoutingConfig } from "../extensions/prewalk-core.mjs"

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "prewalk-runtime-"))
  const entries = []
  const switches = []
  const notes = []
  let files = {}
  const deps = {
    cwd: root,
    now: () => "2025-01-01T00:00:00.000Z",
    snapshot: async () => ({ ...files }),
    appendEntry: (type, data) => entries.push({ type, data }),
    getBranch: () => entries,
    setModel: async (model) => { switches.push(model); return options.switchOk !== false },
    findModel: (model) => model,
    notify: (message) => notes.push(message),
    runCommand: options.runCommand,
    ...options.deps,
  }
  const runtime = createPrewalkRuntime({ config: resolveRoutingConfig(options.config ?? { finalReview: false, milestoneReview: false }), deps })
  return {
    root, entries, switches, notes, runtime,
    setFiles(next) { files = next },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

function plan(root, options = {}) {
  return {
    hardContract: { outcome: "working feature", constraints: ["Do not rollback"], allowedPaths: ["src/"], protectedPaths: ["package.json"] },
    softPlan: { expectedFiles: ["src/a.mjs"], steps: ["implement"] },
    phases: [{
      id: "phase-1",
      todos: [{ id: "todo-1", text: "Implement the feature", status: "pending" }],
      checks: [{ id: "test-1", command: options.checkCommand ?? "node", args: options.checkArgs ?? ["-e", "process.exit(0)"], cwd: root, required: true }],
    }, ...(options.secondPhase ? [{ id: "phase-2", todos: [{ id: "todo-2", text: "Verify", status: "pending" }], checks: [{ id: "test-2", command: "node", args: ["-e", "process.exit(0)"], cwd: root, required: true }] }] : [])],
  }
}

async function beginCheap(fx, extra = {}) {
  const { runtime, root } = fx
  await runtime.start({ runId: "run-1", sessionId: "session-1", workspace: root, goal: "Implement bidirectional routing", frontierModel: "frontier/model", cheapModel: "cheap/model" })
  const file = join(root, ".temp-local", "workflow-plan.md")
  mkdirSync(join(root, ".temp-local"), { recursive: true })
  writeFileSync(file, "approved plan proposal")
  runtime.observeToolCall({ id: "plan-write", name: "write", input: { path: file } })
  runtime.observeToolResult({ id: "plan-write", name: "write", isError: false })
  const submitted = await runtime.checkpoint({ eventId: "plan-1", action: "submit_plan", plan: plan(root, extra) })
  assert.equal(submitted.ok, true)
  const approved = await runtime.approve(submitted.proposalId)
  assert.equal(approved.ok, true)
  assert.equal(runtime.state().stage, "frontier_initial")
  const edit = runtime.observeToolCall({ id: "first-edit", name: "edit", input: { path: join(root, "src/a.mjs") } })
  assert.equal(edit, undefined)
  runtime.observeToolResult({ id: "first-edit", name: "edit", isError: false })
  await runtime.completeToolBatch({ eventId: "initial-edit-batch", toolIds: ["first-edit-result"] })
  const routed = await runtime.turnEnd({ eventId: "initial-turn" })
  assert.equal(routed.action, "switched")
  assert.equal(runtime.state().stage, "cheap")
  return submitted.proposalId
}

async function requestHumanDecision(fx) {
  await beginCheap(fx)
  fx.runtime.observeToolCall({ id: "decision-scope", name: "edit", input: { path: join(fx.root, "package.json") } })
  await fx.runtime.completeToolBatch({ eventId: "decision-scope-batch" })
  await fx.runtime.turnEnd({ eventId: "decision-review" })
  return fx.runtime.checkpoint({ action: "verdict", verdict: "needs-human", reason: "Which existing endpoint should this use?" })
}

test("explicit plan approval preserves one representative edit and switches in the same session", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "frontier/model", cheapModel: "cheap/model" })
    assert.equal(fx.runtime.state().stage, "frontier_plan")
    const outside = fx.runtime.observeToolCall({ id: "too-soon", name: "edit", input: { path: join(fx.root, "src/a.mjs") } })
    assert.equal(outside.block, true)
    const submitted = await fx.runtime.checkpoint({ eventId: "proposal", action: "submit_plan", plan: plan(fx.root) })
    assert.equal(fx.runtime.state().stage, "awaiting_approval")
    assert.equal((await fx.runtime.approve("wrong-id")).ok, false)
    const stale = await fx.runtime.approve(submitted.proposalId, { baseRevision: "stale" })
    assert.equal(stale.ok, false)
    assert.equal(fx.runtime.state().stage, "awaiting_approval")
  } finally { fx.cleanup() }
})

test("a pending initial plan can be revised without restarting Prewalk", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "frontier/model", cheapModel: "cheap/model" })
    const initial = await fx.runtime.checkpoint({ eventId: "initial-plan", action: "submit_plan", plan: plan(fx.root) })
    const revisedPlan = { ...plan(fx.root), hardContract: { ...plan(fx.root).hardContract, outcome: "revised goal" } }
    for (const [name, input] of [
      ["edit", { path: join(fx.root, "src/a.mjs") }],
      ["bash", { command: "printf bypass" }],
      ["prewalk_validate", { checkId: "test-1" }],
      ["prewalk_checkpoint", { action: "progress", phaseId: "phase-1", todos: [] }],
      ["prewalk_checkpoint", { action: "cancel" }],
    ]) {
      assert.equal(fx.runtime.observeToolCall({ id: `blocked-${name}-${input.action ?? "tool"}`, name, input })?.block, true)
    }
    assert.equal(fx.runtime.state().initialApproval, null)
    assert.equal(fx.runtime.observeToolCall({ id: "revised-plan-tool", name: "prewalk_checkpoint", input: { action: "submit_plan", plan: revisedPlan } }), undefined)
    const revised = await fx.runtime.checkpoint({ eventId: "revised-plan", action: "submit_plan", plan: revisedPlan })
    fx.runtime.observeToolResult({ id: "revised-plan-tool", name: "prewalk_checkpoint", isError: false })

    assert.equal(revised.ok, true)
    assert.notEqual(revised.proposalId, initial.proposalId)
    assert.equal(fx.runtime.state().stage, "awaiting_approval")
    assert.equal(fx.runtime.state().proposals.find((proposal) => proposal.id === initial.proposalId).status, "superseded")
    assert.equal(fx.runtime.state().proposals.find((proposal) => proposal.id === revised.proposalId).status, "pending")
    assert.equal((await fx.runtime.approve(initial.proposalId)).ok, false)

    assert.equal((await fx.runtime.approve(revised.proposalId)).ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_initial")
    assert.equal(fx.runtime.state().initialApproval.proposalId, revised.proposalId)
    assert.equal(fx.runtime.state().plan.hardContract.outcome, "revised goal")
  } finally { fx.cleanup() }
})

test("Cheap can request a mid-work plan revision and only a displayed human approval changes checks", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    const original = fx.runtime.state()
    assert.equal((await fx.runtime.checkpoint({ action: "submit_plan", plan: plan(fx.root) })).ok, false)
    const requested = await fx.runtime.checkpoint({ eventId: "request-revision", action: "request_revision", reason: "Replace the required check" })
    assert.equal(requested.ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_review_pending")
    await fx.runtime.turnEnd({ eventId: "route-revision" })
    assert.equal(fx.runtime.state().stage, "frontier_review")
    const revised = plan(fx.root, { checkArgs: ["-e", "process.exit(1)"] })
    const proposed = await fx.runtime.checkpoint({ eventId: "propose-revision", action: "propose", kind: "plan", patch: revised })
    assert.equal(proposed.ok, true, proposed.reason)
    assert.equal(fx.runtime.state().stage, "awaiting_human_approval")
    assert.deepEqual(fx.runtime.state().phases, original.phases)
    assert.equal((await fx.runtime.approve(proposed.proposalId, { baseRevision: "old" })).ok, false)
    assert.equal((await fx.runtime.approve(proposed.proposalId)).ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.state().planRevision, original.planRevision + 1)
    assert.deepEqual(fx.runtime.state().phases[0].checks[0].args, revised.phases[0].checks[0].args)
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })).ok, false)
    const reviewed = await fx.runtime.checkpoint({ eventId: "revision-confirmed", action: "verdict", phaseId: "phase-1", verdict: "continue" })
    assert.equal(reviewed.ok, true)
    assert.equal(fx.runtime.state().stage, "cheap_pending")
    await fx.runtime.turnEnd({ eventId: "resume-cheap" })
    assert.equal(fx.runtime.state().stage, "cheap")
    assert.equal(fx.runtime.state().runId, original.runId)
    assert.equal(fx.runtime.state().sessionId, original.sessionId)
  } finally { fx.cleanup() }
})

test("rejected mid-work revisions preserve the current plan and support a fresh proposal", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "request_revision", reason: "Adjust checks" })
    await fx.runtime.turnEnd({ eventId: "revision-turn" })
    const first = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: plan(fx.root, { checkArgs: ["-e", "process.exit(1)"] }) })
    assert.equal((await fx.runtime.rejectProposal(first.proposalId, { feedback: "Keep the check passing" })).ok, true)
    assert.equal(fx.runtime.state().stage, "awaiting_revision")
    assert.equal((await fx.runtime.provideRevisionFeedback("Keep the check passing")).ok, true)
    const second = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: plan(fx.root, { checkArgs: ["-e", "process.exit(2)"] }) })
    assert.equal(second.ok, true)
    assert.notEqual(first.proposalId, second.proposalId)
    assert.equal((await fx.runtime.approve(first.proposalId)).ok, false)
    await fx.runtime.cancel()
    assert.equal((await fx.runtime.approve(second.proposalId)).ok, false)
    assert.equal(fx.runtime.observeToolCall({ id: "ordinary-bash", name: "bash", input: { command: "pwd" } }), undefined)
  } finally { fx.cleanup() }
})

test("a revised check cannot reuse a previous success while unrelated progress survives", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: false } })
  try {
    await beginCheap(fx, { secondPhase: true })
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    const before = fx.runtime.state()
    await fx.runtime.checkpoint({ action: "request_revision", reason: "Change test args" })
    await fx.runtime.turnEnd({ eventId: "review-revision" })
    const changed = plan(fx.root, { secondPhase: true, checkArgs: ["-e", "process.exit(1)"] })
    const proposed = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: changed })
    await fx.runtime.approve(proposed.proposalId)
    assert.equal(fx.runtime.state().phases[0].todos[0].status, "ready")
    assert.deepEqual(fx.runtime.state().completed, before.completed)
    assert.notEqual(fx.runtime.state().validation_results["test-1"]?.status, "passed")
    await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "continue" })
    await fx.runtime.turnEnd({ eventId: "return-to-cheap" })
    await fx.runtime.completeToolBatch({ eventId: "after-revision" })
    assert.equal(fx.runtime.state().stage, "cheap", "changed checks must not trigger a false phase pass")
  } finally { fx.cleanup() }
})

test("revision request survives reload and respects the escalation limit", async () => {
  const fx = fixture({ config: { maxEscalations: 1 } })
  try {
    await beginCheap(fx)
    const request = await fx.runtime.checkpoint({ action: "request_revision", reason: "Replace a planned check" })
    assert.equal(request.ok, true)
    const restored = createPrewalkRuntime({ deps: { cwd: fx.root, getBranch: () => fx.entries, appendEntry: (type, data) => fx.entries.push({ type, data }), snapshot: async () => ({}) } })
    assert.equal((await restored.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal(restored.state().resumeStage, "frontier_review_pending")
    assert.equal(restored.state().revisionRequest?.feedback, "Replace a planned check")
    assert.equal((await restored.resume()).ok, true)
    assert.equal((await restored.turnEnd({ eventId: "restored-revision" })).action, "switched")
    assert.equal(restored.state().stage, "frontier_review")
    await restored.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "continue" })
    await restored.turnEnd({ eventId: "restore-cheap" })
    const limited = await restored.checkpoint({ action: "request_revision", reason: "Another revision" })
    assert.equal(limited.ok, false)
    assert.equal(restored.state().stage, "stopped")
  } finally { fx.cleanup() }
})

test("revisions preserve completed phases and refuse to alter already approved phase history", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: false } })
  try {
    await beginCheap(fx, { secondPhase: true })
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "phase-ready" })
    await fx.runtime.turnEnd({ eventId: "review-phase-1" })
    await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    await fx.runtime.turnEnd({ eventId: "cheap-phase-2" })
    assert.deepEqual(fx.runtime.state().completed, ["phase-1"])
    const old = fx.runtime.state()
    await fx.runtime.checkpoint({ action: "request_revision", reason: "Change phase 2 check" })
    await fx.runtime.turnEnd({ eventId: "revise-phase-2" })
    const updated = structuredClone(old.plan)
    updated.phases = structuredClone(old.phases)
    updated.phases[1].checks[0].args = ["-e", "process.exit(1)"]
    const invalid = structuredClone(updated)
    invalid.phases[0].todos[0].text = "Rewrite completed phase"
    assert.equal((await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: invalid })).ok, false)
    const proposed = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: updated })
    assert.equal(proposed.ok, true, proposed.reason)
    assert.equal((await fx.runtime.approve(proposed.proposalId)).ok, true)
    assert.deepEqual(fx.runtime.state().completed, ["phase-1"])
    assert.equal(fx.runtime.state().currentPhaseId, "phase-2")
  } finally { fx.cleanup() }
})

test("an approved plan revision restores on Frontier and cannot pass a ready phase before confirmation", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.checkpoint({ action: "request_revision", reason: "Change constraints without completing the phase" })
    await fx.runtime.turnEnd({ eventId: "review-constraints" })
    const patch = structuredClone(fx.runtime.state().plan)
    patch.hardContract.constraints.push("Preserve existing behavior")
    const proposal = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch })
    assert.equal(proposal.ok, true, proposal.reason)
    assert.equal((await fx.runtime.approve(proposal.proposalId)).ok, true)
    const saved = fx.runtime.state()
    const restored = createPrewalkRuntime({ deps: {
      cwd: fx.root, getBranch: () => fx.entries,
      appendEntry: (type, data) => fx.entries.push({ type, data }),
      snapshot: async () => ({}),
    } })
    assert.equal((await restored.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal(restored.state().resumeStage, "frontier_review")
    assert.equal((await restored.resume()).ok, true)
    assert.equal((await restored.checkpoint({ action: "verdict", verdict: "pass", phaseId: "phase-1" })).reason, "confirm-plan-revision-before-phase-review")
    assert.deepEqual(restored.state().completed, [])
    assert.equal((await restored.checkpoint({ action: "verdict", verdict: "continue", phaseId: "phase-1" })).ok, true)
    assert.equal((await restored.turnEnd({ eventId: "confirmed-revision" })).action, "switched")
    assert.equal(restored.state().stage, "cheap")
    assert.equal(restored.state().hardRevision, saved.hardRevision)
  } finally { fx.cleanup() }
})

test("revision approval rejects external edits and model-switch failure leaves routing stopped", async () => {
  for (const failure of ["external-edit", "model-switch"]) {
    const fx = fixture()
    try {
      await beginCheap(fx)
      if (failure === "model-switch") {
        const state = fx.runtime.state()
        const restored = createPrewalkRuntime({ deps: { cwd: fx.root, getBranch: () => fx.entries, snapshot: async () => ({}), setModel: async () => false } })
        await restored.restore({ sessionId: state.sessionId, workspace: fx.root })
        await restored.resume()
        await restored.checkpoint({ action: "request_revision", reason: "Update checks" })
        assert.equal((await restored.turnEnd({ eventId: "failed-revision-switch" })).reason, "model-switch-failed")
        assert.equal(restored.state().stage, "stopped")
        assert.equal(restored.observeToolCall({ id: "after-failure", name: "read", input: { path: "README.md" } }), undefined)
      } else {
        await fx.runtime.checkpoint({ action: "request_revision", reason: "Update checks" })
        await fx.runtime.turnEnd({ eventId: "propose-after-request" })
        const proposed = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: plan(fx.root) })
        fx.setFiles({ "src/a.mjs": "external edit" })
        assert.equal((await fx.runtime.approve(proposed.proposalId)).reason, "worktree-changed-before-approval")
        assert.equal(fx.runtime.state().stage, "stopped")
      }
    } finally { fx.cleanup() }
  }
})

test("normal phase validation and final approval remain required after a revision confirmation", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: true } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "request_revision", reason: "Update the check" })
    await fx.runtime.turnEnd({ eventId: "revision-frontier" })
    const proposed = await fx.runtime.checkpoint({ action: "propose", kind: "plan", patch: plan(fx.root, { checkArgs: ["-e", "process.stdout.write('ok')"] }) })
    assert.equal((await fx.runtime.approve(proposed.proposalId)).ok, true)
    await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "continue" })
    await fx.runtime.turnEnd({ eventId: "revised-build" })
    assert.deepEqual(fx.runtime.state().completed, [])
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.completeToolBatch({ eventId: "missing-revised-check" })
    assert.equal(fx.runtime.state().stage, "cheap")
    assert.equal((await fx.runtime.validate("test-1")).status, "passed")
    await fx.runtime.completeToolBatch({ eventId: "ready-revised-check" })
    await fx.runtime.turnEnd({ eventId: "normal-final-review" })
    assert.equal(fx.runtime.state().reviewIncludesFinal, true)
    const passed = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    assert.equal(passed.ok, true)
    assert.equal(fx.runtime.state().stage, "awaiting_final_approval")
    assert.equal((await fx.runtime.approve(passed.finalProposalId)).ok, true)
    assert.equal(fx.runtime.state().stage, "complete")
  } finally { fx.cleanup() }
})

test("ordinary Cheap shell and unknown tools remain usable; exact bash check outcomes are observed", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    assert.equal(fx.runtime.observeToolCall({ id: "ordinary-shell", name: "bash", input: { command: "printf ok" } }), undefined)
    assert.equal(fx.runtime.observeToolCall({ id: "unknown-tool", name: "third-party", input: { action: "inspect" } }), undefined)
    fx.runtime.observeToolResult({ id: "ordinary-shell", name: "bash", isError: true })
    assert.equal(fx.runtime.state().failure_count, 0)
    fx.runtime.observeToolCall({ id: "check-call", name: "bash", input: { command: "node -e process.exit(0)" } })
    fx.runtime.observeToolResult({ id: "check-call", name: "bash", isError: false, content: [{ type: "text", text: "fake output: exit code 0" }] })
    await fx.runtime.completeToolBatch({ eventId: "batch-1", toolIds: ["session-result-1"] })
    const audit = fx.entries.filter((entry) => entry.type === "prewalk-audit" && entry.data.type === "tool-batch-complete").at(-1).data
    assert.deepEqual(audit.tools, [{ id: "ordinary-shell", name: "bash" }, { id: "check-call", name: "bash" }])
    assert.ok(audit.toolIds.includes("ordinary-shell"))
    assert.ok(audit.toolIds.includes("session-result-1"))
    assert.equal(Object.values(fx.runtime.state().validation_results).some((result) => result.status === "passed"), false)
    assert.equal(Object.values(fx.runtime.state().validation_results).some((result) => result.status === "unknown"), true)
    fx.runtime.observeToolCall({ id: "trusted-check", name: "bash", input: { command: "node -e process.exit(0)" } })
    fx.runtime.observeToolResult({ id: "trusted-check", name: "bash", exitCode: 0 })
    assert.equal(fx.runtime.state().validation_results["test-1"].status, "passed")
  } finally { fx.cleanup() }
})

test("phase review is automatic after ready TODOs and fresh successful checks, then advances or repairs", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: true } })
  try {
    await beginCheap(fx, { secondPhase: true })
    await fx.runtime.checkpoint({ eventId: "progress", action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.completeToolBatch({ eventId: "missing-check" })
    assert.equal(fx.runtime.state().stage, "cheap")
    const validation = await fx.runtime.validate("test-1", { toolCallId: "validation-call" })
    assert.equal(validation.exitCode, 0)
    const checkAudit = fx.entries.filter((entry) => entry.type === "prewalk-audit" && entry.data.type === "validation-result").at(-1).data
    assert.deepEqual(checkAudit.tools, [{ id: "validation-call", name: "prewalk_validate" }])
    assert.equal(checkAudit.validationOutcome.checkId, "test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-batch" })
    const routed = await fx.runtime.turnEnd({ eventId: "review-turn" })
    assert.equal(routed.action, "switched")
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.switches.at(-1), "frontier/model")
    const verdict = await fx.runtime.checkpoint({ eventId: "review-pass", action: "verdict", phaseId: "phase-1", verdict: "pass" })
    assert.equal(verdict.ok, true)
    assert.equal(fx.runtime.state().currentPhaseId, "phase-2")
    assert.equal(fx.runtime.state().stage, "cheap_pending")
  } finally { fx.cleanup() }
})

test("repair stays on the same phase, invalidates approval on edits, and deduplicates completed batches", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: true } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ eventId: "ready", action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "batch-ready" })
    await fx.runtime.turnEnd({ eventId: "turn-review" })
    await fx.runtime.checkpoint({ eventId: "repair", action: "verdict", phaseId: "phase-1", verdict: "repair", pendingTodoIds: ["todo-1"] })
    assert.equal(fx.runtime.state().stage, "cheap_pending")
    assert.equal(fx.runtime.state().currentPhaseId, "phase-1")
    assert.equal(fx.runtime.state().phases[0].todos[0].status, "pending")
    const duplicate = await fx.runtime.completeToolBatch({ eventId: "batch-ready" })
    assert.equal(duplicate.reason, "duplicate-event")
    fx.setFiles({ "src/a.mjs": "edited-after-review" })
    const changed = await fx.runtime.completeToolBatch({ eventId: "edit-after-review" })
    assert.equal(changed.changedFiles.includes("src/a.mjs"), true)
    assert.notEqual(fx.runtime.state().sourceRevision, fx.runtime.state().validation_results["test-1"].revision)
  } finally { fx.cleanup() }
})

test("last phase review coalesces final review and requires human completion approval", async () => {
  const fx = fixture({ config: { finalReview: true, milestoneReview: true } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ eventId: "progress", action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "batch" })
    await fx.runtime.turnEnd({ eventId: "review" })
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.state().reviewIncludesFinal, true)
    const routeAudit = fx.entries.filter((entry) => entry.type === "prewalk-audit" && entry.data.type === "route-review").at(-1).data
    assert.equal(routeAudit.currentModel, "cheap/model", "pending routing must still attribute work to the producing model")
    const result = await fx.runtime.checkpoint({ eventId: "verdict", action: "verdict", phaseId: "phase-1", verdict: "pass" })
    assert.equal(result.finalProposalId, fx.runtime.state().finalProposalId)
    assert.equal(fx.runtime.state().stage, "awaiting_final_approval")
    const finalAudit = fx.entries.filter((entry) => entry.type === "prewalk-audit" && entry.data.type === "final-review-passed").at(-1).data
    assert.equal(finalAudit.currentModel, "frontier/model", "a human gate must not attribute the Frontier review to Cheap")
    assert.equal((await fx.runtime.approve(result.finalProposalId)).ok, true)
    assert.equal(fx.runtime.state().stage, "complete")
  } finally { fx.cleanup() }
})

test("hard proposals require exact human approval, reject stale bases, and never alter contract on proposal", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: false } })
  try {
    await beginCheap(fx)
    fx.runtime.observeToolCall({ id: "need-boundary", name: "write", input: { path: "tests/new_test.mjs" } })
    await fx.runtime.completeToolBatch({ eventId: "boundary-batch" })
    await fx.runtime.turnEnd({ eventId: "boundary-review" })
    const proposal = await fx.runtime.checkpoint({ eventId: "hard-proposal", action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "tests/"] } })
    assert.equal(proposal.ok, true)
    assert.equal(fx.runtime.state().hardContract.allowedPaths.includes("tests/"), false)
    assert.equal((await fx.runtime.approve(proposal.proposalId, { baseRevision: "old" })).ok, false)
    assert.equal((await fx.runtime.approve(proposal.proposalId)).ok, true)
    assert.equal(fx.runtime.state().hardContract.allowedPaths.includes("tests/"), true)
    assert.deepEqual(await fx.runtime.rejectProposal("unknown"), { ok: false, reason: "proposal-not-found" })
  } finally { fx.cleanup() }
})

test("known out-of-scope mutation is blocked before execution and schedules Frontier", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: false } })
  try {
    await beginCheap(fx)
    const blocked = fx.runtime.observeToolCall({ id: "outside-edit", name: "write", input: { path: "docs/readme.md" } })
    assert.equal(blocked.block, true)
    assert.equal(blocked.routeScheduled, true)
    const duplicateDeviation = fx.runtime.observeToolCall({ id: "protected-edit", name: "edit", input: { path: "package.json" } })
    assert.equal(duplicateDeviation.block, true)
    const switchResult = await fx.runtime.turnEnd({ eventId: "blocked-review" })
    assert.equal(switchResult.action, "switched")
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.state().lastEscalationReason, "deviation")
    assert.equal(fx.runtime.state().escalation_count, 1)
  } finally { fx.cleanup() }
})

test("identified command failure uses real exit status; unknown shell errors do not count and retries are bounded", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: false, failureThreshold: 2 } })
  try {
    await beginCheap(fx, { checkCommand: process.execPath, checkArgs: ["-e", "process.exit(7)"] })
    const first = await fx.runtime.validate("test-1")
    assert.equal(first.exitCode, 7)
    assert.equal(first.status, "failed")
    assert.equal(fx.runtime.state().failure_count, 1)
    assert.equal(fx.runtime.state().stage, "cheap")
    assert.equal(fx.runtime.state().escalation_count, 0)
    fx.runtime.observeToolCall({ id: "random", name: "bash", input: { command: "definitely-not-a-check" } })
    fx.runtime.observeToolResult({ id: "random", name: "bash", isError: true })
    assert.equal(fx.runtime.state().failure_count, 1)
    await fx.runtime.validate("test-1")
    assert.equal(fx.runtime.state().stage, "frontier_review_pending")
    assert.equal(fx.runtime.state().escalation_count, 1)
    await fx.runtime.turnEnd({ eventId: "failure-escalation" })
    assert.equal(fx.runtime.state().stage, "frontier_review")
  } finally { fx.cleanup() }
})

test("dirty baseline edits, path escapes, symlinks, cancellation, and explicit terminal limits are handled", async () => {
  const fx = fixture({ config: { maxEscalations: 1, maxRetries: 1, maxSteps: 1, finalReview: false, milestoneReview: false } })
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "frontier/model", cheapModel: "cheap/model", baseline: { "src/a.mjs": "old" } })
    const traversal = fx.runtime.observeToolCall({ id: "escape", name: "write", input: { path: "../../outside" } })
    assert.equal(traversal.block, true)
    await fx.runtime.checkpoint({ eventId: "cancel", action: "cancel" })
    assert.equal(fx.runtime.state().stage, "stopped")
    assert.equal((await fx.runtime.resume()).ok, false)
    assert.equal(fx.runtime.state().stopReason, "cancelled")
  } finally { fx.cleanup() }
})

test("state and audit entries restore only for matching session ownership; persistence failures pause", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    assert.equal(fx.entries.some((entry) => entry.type === "prewalk-state"), true)
    const latest = fx.entries.filter((entry) => entry.type === "prewalk-state").at(-1).data.state
    fx.entries.push({ type: "prewalk-state", data: { version: 1, state: { ...latest, stateRevision: latest.stateRevision - 1, stage: "frontier_plan" } } })
    const restored = createPrewalkRuntime({ config: { finalReview: false, milestoneReview: false }, deps: { cwd: fx.root, getBranch: () => fx.entries, appendEntry: () => {}, snapshot: async () => ({}) } })
    assert.equal((await restored.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal(restored.state().stage, "paused")
    assert.equal(restored.state().resumeStage, latest.stage, "a lower revision in the same run must not replace newer state")
    assert.equal(restored.state().step_count, latest.step_count)
    const wrongSession = createPrewalkRuntime({ config: {}, deps: { getBranch: () => fx.entries } })
    assert.equal((await wrongSession.restore({ sessionId: "other", workspace: fx.root })).ok, false)
    const broken = createPrewalkRuntime({ config: {}, deps: { cwd: fx.root, snapshot: async () => ({}), appendEntry: () => { throw new Error("disk full") } } })
    assert.equal((await broken.start({ runId: "r", sessionId: "s", workspace: fx.root, goal: "g", frontierModel: "f/m", cheapModel: "c/m" })).ok, false)
    assert.equal(broken.state().stage, "stopped")
    assert.match(broken.state().stopReason, /persistence/i)
  } finally { fx.cleanup() }
})

test("review context is bounded without losing required constraints; tool-pair helper is stable", async () => {
  const fx = fixture({ config: { contextBudgetChars: 2000, finalReview: false, milestoneReview: false } })
  try {
    await beginCheap(fx)
    const context = fx.runtime.reviewContext({ diff: "d".repeat(2000), failures: ["f".repeat(1000)] })
    assert.equal(context.ok, true)
    assert.ok(context.text.length <= 2000)
    assert.match(context.text, /Do not rollback/)
    const tiny = createPrewalkRuntime({ config: { contextBudgetChars: 100, finalReview: false, milestoneReview: false }, deps: {} })
    await tiny.start({ runId: "r2", sessionId: "s2", workspace: fx.root, goal: "g", frontierModel: "f/m", cheapModel: "c/m", baseline: {} })
    const mandatory = tiny.reviewContext()
    assert.equal(mandatory.ok, false)
    assert.equal(tiny.state().stage, "stopped")
  } finally { fx.cleanup() }
})

test("unavailable model and model-switch errors leave a durable stop without auto-continuation", async () => {
  const options = { switchOk: true, config: { finalReview: true, milestoneReview: false } }
  const fx = fixture(options)
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ eventId: "progress-for-review", action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-for-review" })
    options.switchOk = false
    const outcome = await fx.runtime.turnEnd({ eventId: "turn" })
    assert.equal(outcome.action, "stopped")
    assert.equal(fx.runtime.state().stage, "stopped")
    assert.equal(fx.runtime.state().stopReason, "model-switch-failed")
    assert.equal((await fx.runtime.turnEnd({ eventId: "again" })).action, "none")
  } finally { fx.cleanup() }
})

test("bounded history preserves tool-call/result pairs and rejects orphaned or oversized evidence", () => {
  const user = { role: "user", content: "keep this" }
  const call = { role: "assistant", content: [{ type: "toolCall", id: "call-1" }] }
  const result = { role: "toolResult", toolCallId: "call-1", content: "result" }
  const orphan = { role: "assistant", content: [{ type: "toolCall", id: "missing" }] }
  const bounded = buildBoundedReviewMessages([user, call, result, orphan], 1000)
  assert.equal(bounded.ok, true)
  assert.deepEqual(bounded.messages, [user, call, result])
  assert.equal(buildBoundedReviewMessages([user], 1).ok, false)
  assert.throws(() => captureGitSnapshot(tmpdir()), /Git snapshot unavailable/)
  const root = mkdtempSync(join(tmpdir(), "prewalk-git-snapshot-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: root })
    writeFileSync(join(root, "untracked.txt"), "observed")
    assert.deepEqual(Object.keys(captureGitSnapshot(root)), ["untracked.txt"])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("plan validator rejects duplicate phases, invalid checks, missing evidence, and escaping paths", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "plan-run", sessionId: "plan-session", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    const base = plan(fx.root)
    const variants = [
      { ...base, hardContract: null },
      { ...base, phases: [] },
      { ...base, phases: [{ ...base.phases[0], todos: [] }] },
      { ...base, phases: [{ ...base.phases[0], checks: [{ id: "bad", command: "node", cwd: "../" }] }] },
      { ...base, phases: [{ ...base.phases[0], checks: [] }] },
      { ...base, hardContract: { ...base.hardContract, allowedPaths: ["../outside"] } },
    ]
    for (let index = 0; index < variants.length; index++) {
      assert.equal((await fx.runtime.checkpoint({ eventId: `invalid-${index}`, action: "submit_plan", plan: variants[index] })).ok, false)
    }
    const duplicate = { ...base, phases: [base.phases[0], { ...base.phases[0] }] }
    assert.equal((await fx.runtime.checkpoint({ eventId: "duplicate-phase", action: "submit_plan", plan: duplicate })).ok, false)
  } finally { fx.cleanup() }
})

test("invalid plans, unknown checks, stale lifecycle events, and turn limits fail closed", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: false, maxSteps: 1 } })
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    assert.equal(fx.runtime.status().stage, "frontier_plan")
    assert.equal((await fx.runtime.checkpoint({ eventId: "bad-plan", action: "submit_plan", plan: {} })).ok, false)
    const started = await fx.runtime.turnStart({ eventId: "turn-1", model: "f/m" })
    assert.equal(started.action, "continue")
    assert.equal((await fx.runtime.turnStart({ eventId: "turn-2", model: "f/m" })).action, "stopped")
    assert.equal(fx.runtime.state().stopReason, "limit-reached")
  } finally { fx.cleanup() }
})

test("validation distinguishes unknown, timeout, and host exit outcomes; manual model change pauses", async () => {
  const results = [{ status: null }, { status: 9 }, { timedOut: true, status: null }, { status: 0 }]
  const fx = fixture({ config: { finalReview: false, milestoneReview: false, failureThreshold: 9 }, deps: { runCommand: async () => results.shift() } })
  try {
    await beginCheap(fx)
    assert.equal((await fx.runtime.validate("missing")).status, "unknown")
    assert.equal((await fx.runtime.validate("test-1")).status, "unknown")
    assert.equal((await fx.runtime.validate("test-1")).status, "failed")
    assert.equal((await fx.runtime.validate("test-1")).status, "timeout")
    assert.equal((await fx.runtime.validate("test-1")).status, "passed")
    assert.equal(fx.runtime.state().failureStreaks["test-1"], 0)
    assert.equal((await fx.runtime.modelSelected("other/model")).action, "stopped")
    assert.equal(fx.runtime.state().stage, "stopped")
  } finally { fx.cleanup() }
})

test("optional injected adapters, reload guards, usage attribution, and terminal status remain explicit", async () => {
  const notices = []
  const runtime = createPrewalkRuntime({ config: { finalReview: false, milestoneReview: false }, deps: { cwd: tmpdir(), notify: (message) => notices.push(message) } })
  assert.equal((await runtime.start({})).ok, false)
  assert.equal((await runtime.restore({ sessionId: "none", workspace: tmpdir() })).ok, false)
  assert.equal(runtime.reviewContext().reason, "no-active-run")
  const started = await runtime.start({ runId: "minimal", sessionId: "minimal-session", workspace: tmpdir(), goal: "minimal", frontierModel: "f/m", cheapModel: "c/m", baseline: {} })
  assert.equal(started.ok, true)
  await runtime.recordUsage({ role: "user" })
  await runtime.recordUsage({ role: "assistant", usage: { input: 3, output: 4, cost: { total: 0.01 } } })
  assert.equal(runtime.state().usage[0].attribution, "unknown")
  assert.equal(runtime.state().usage[0].costIsEstimate, true)
  assert.equal(runtime.agentSettled().stage, "frontier_plan")
  assert.equal((await runtime.modelSelected("f/m")).ok, true)
  assert.throws(() => runtime.configure({ failureThreshold: 0 }), /active/)
  await runtime.pause("test-pause")
  assert.throws(() => runtime.configure({ failureThreshold: 0 }), /failureThreshold/)
  runtime.configure({ finalReview: false, milestoneReview: false, maxSteps: 3 })
})

test("review budget is checked against the proposed phases before approval", async () => {
  const fx = fixture({ config: { maxEscalations: 1, milestoneReview: true, finalReview: true } })
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    const result = await fx.runtime.checkpoint({ action: "submit_plan", plan: plan(fx.root, { secondPhase: true }) })
    assert.deepEqual(result.budgetShortfall, { required: 2, available: 1 })
    assert.equal(fx.runtime.state().stage, "awaiting_approval")
  } finally { fx.cleanup() }
})

test("a task can be restored twice while paused without losing its continuation stage", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    const deps = { cwd: fx.root, getBranch: () => fx.entries, appendEntry: (type, data) => fx.entries.push({ type, data }), snapshot: async () => ({}) }
    const first = createPrewalkRuntime({ config: {}, deps })
    assert.equal((await first.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal(first.state().stage, "paused")
    const second = createPrewalkRuntime({ config: {}, deps })
    assert.equal((await second.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal((await second.resume()).ok, true)
    assert.equal(second.state().stage, "cheap")
  } finally { fx.cleanup() }
})

test("a checkless phase needs a newly observed repository artifact rather than self-reported TODOs", async () => {
  const fx = fixture({ config: { milestoneReview: true } })
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "Artifact task", frontierModel: "f/m", cheapModel: "c/m" })
    mkdirSync(join(fx.root, ".temp-local"), { recursive: true })
    const planPath = join(fx.root, ".temp-local", "workflow-plan.md")
    writeFileSync(planPath, "proposed")
    fx.runtime.observeToolCall({ id: "artifact-plan", name: "write", input: { path: planPath } })
    fx.runtime.observeToolResult({ id: "artifact-plan", name: "write" })
    const p = plan(fx.root)
    p.phases[0].checks = []
    p.phases[0].evidenceRequired = ["src/artifact.txt"]
    const submitted = await fx.runtime.checkpoint({ action: "submit_plan", plan: p })
    assert.equal(submitted.ok, true)
    await fx.runtime.approve(submitted.proposalId)
    fx.runtime.observeToolCall({ id: "artifact-edit", name: "write", input: { path: join(fx.root, "src/artifact.txt") } })
    fx.runtime.observeToolResult({ id: "artifact-edit", name: "write" })
    await fx.runtime.turnEnd({ eventId: "artifact-handoff" })
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }], evidence: ["src/artifact.txt"] })
    await fx.runtime.completeToolBatch({ eventId: "artifact-missing" })
    assert.equal(fx.runtime.state().stage, "cheap")
    mkdirSync(join(fx.root, "src"), { recursive: true })
    writeFileSync(join(fx.root, "src/artifact.txt"), "observed artifact")
    fx.setFiles({ "src/artifact.txt": "observed" })
    await fx.runtime.completeToolBatch({ eventId: "artifact-created" })
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }], evidence: ["src/artifact.txt"] })
    await fx.runtime.completeToolBatch({ eventId: "artifact-verified" })
    assert.equal(fx.runtime.state().stage, "frontier_review_pending")
  } finally { fx.cleanup() }
})

test("restore uses the last run in the active branch and restores its configured limits", async () => {
  const fx = fixture({ config: { maxSteps: 3, milestoneReview: false } })
  try {
    await beginCheap(fx)
    await fx.runtime.cancel()
    await fx.runtime.start({ runId: "run-2", sessionId: "session-1", workspace: fx.root, goal: "Second task", frontierModel: "f/m", cheapModel: "c/m" })
    const restored = createPrewalkRuntime({ deps: { cwd: fx.root, getBranch: () => fx.entries, appendEntry: (type, data) => fx.entries.push({ type, data }), snapshot: async () => ({}) } })
    assert.equal((await restored.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal(restored.state().runId, "run-2")
    assert.equal(restored.state().config.maxSteps, 3)
    assert.equal(restored.state().stage, "paused")
  } finally { fx.cleanup() }
})

test("completion cannot be approved before all phases pass", async () => {
  const fx = fixture({ config: { milestoneReview: false, finalReview: false } })
  try {
    await beginCheap(fx, { secondPhase: true })
    const result = await fx.runtime.checkpoint({ action: "finish" })
    assert.equal(result.ok, false)
    assert.equal(fx.runtime.state().stage, "cheap")
  } finally { fx.cleanup() }
})

test("last milestone pass reaches human completion when the separate final review is disabled", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: false } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-last-milestone" })
    await fx.runtime.turnEnd({ eventId: "last-milestone-review" })
    const result = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    assert.equal(result.ok, true)
    assert.equal(fx.runtime.state().stage, "awaiting_final_approval")
    assert.ok(result.finalProposalId)
  } finally { fx.cleanup() }
})

test("an explicit finish request cannot bypass a ready but unreviewed phase", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: false } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    const result = await fx.runtime.checkpoint({ action: "finish" })
    assert.equal(result.ok, false)
    assert.equal(fx.runtime.state().stage, "cheap")
  } finally { fx.cleanup() }
})

test("a successful observed built-in bash check supplies fresh evidence without a command allowlist", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: false } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    fx.runtime.observeToolCall({ id: "bash-check", name: "bash", input: { command: "node -e process.exit(0)" } })
    fx.runtime.observeToolResult({ id: "bash-check", name: "bash", isError: false, exitCode: 0 })
    await fx.runtime.completeToolBatch({ eventId: "observed-success" })
    assert.equal(fx.runtime.state().validation_results["test-1"].status, "passed")
    assert.equal(fx.runtime.state().stage, "frontier_review_pending")
  } finally { fx.cleanup() }
})

test("an external edit after final review invalidates the pending human approval", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: true } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-final" })
    await fx.runtime.turnEnd({ eventId: "review-final" })
    const verdict = await fx.runtime.checkpoint({ action: "verdict", verdict: "pass", phaseId: "phase-1" })
    assert.equal(verdict.ok, true)
    fx.setFiles({ "src/late.mjs": "externally edited" })
    const approval = await fx.runtime.approve(verdict.finalProposalId)
    assert.equal(approval.ok, false)
    assert.equal(fx.runtime.state().stage, "stopped")
    assert.equal(fx.runtime.state().stopReason, "worktree-changed-before-approval")
  } finally { fx.cleanup() }
})

test("unreviewed phases advance automatically when milestone review is disabled", async () => {
  const fx = fixture({ config: { milestoneReview: false, finalReview: false } })
  try {
    await beginCheap(fx, { secondPhase: true })
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "phase-1-done" })
    assert.equal(fx.runtime.state().currentPhaseId, "phase-2")
    assert.equal(fx.runtime.state().escalation_count, 0)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-2", todos: [{ id: "todo-2", status: "ready" }] })
    await fx.runtime.validate("test-2")
    await fx.runtime.completeToolBatch({ eventId: "phase-2-done" })
    assert.equal(fx.runtime.state().stage, "awaiting_final_approval")
    assert.equal(fx.runtime.state().escalation_count, 0)
  } finally { fx.cleanup() }
})

test("a Frontier may continue within approved scope without falsely passing a phase", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: false } })
  try {
    await beginCheap(fx)
    const deviation = fx.runtime.observeToolCall({ id: "blocked", name: "write", input: { path: join(fx.root, "package.json") } })
    assert.equal(deviation.block, true)
    await fx.runtime.completeToolBatch({ eventId: "blocked-batch" })
    await fx.runtime.turnEnd({ eventId: "blocked-turn" })
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.observeToolCall({ id: "review-edit", name: "edit", input: { path: join(fx.root, "src/a.mjs") } }).block, true)
    assert.equal(fx.runtime.observeToolCall({ id: "review-diff", name: "bash", input: { command: "git diff --stat" } }), undefined)
    fx.runtime.observeToolResult({ id: "review-diff", name: "bash", exitCode: 0 })
    const outside = await fx.runtime.checkpoint({ action: "propose", kind: "soft", patch: { expectedFiles: ["../outside.txt"] } })
    assert.equal(outside.ok, false)
    assert.equal(fx.runtime.state().softRevision, 0)
    const refined = await fx.runtime.checkpoint({ action: "propose", kind: "soft", patch: { expectedFiles: ["src/a.mjs", "src/b.mjs"] } })
    assert.equal(refined.ok, true)
    assert.equal(fx.runtime.state().hardContract.protectedPaths.includes("package.json"), true)
    const outcome = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "continue" })
    assert.equal(outcome.ok, true)
    await fx.runtime.turnEnd({ eventId: "return-cheap" })
    assert.equal(fx.runtime.state().stage, "cheap")
    assert.deepEqual(fx.runtime.state().completed, [])
  } finally { fx.cleanup() }
})

test("Frontier needs-human verdict creates an explicit approvable question without changing boundaries", async () => {
  const fx = fixture({ config: { milestoneReview: true } })
  try {
    await beginCheap(fx)
    fx.runtime.observeToolCall({ id: "blocked-human", name: "edit", input: { path: join(fx.root, "package.json") } })
    await fx.runtime.completeToolBatch({ eventId: "blocked-human-batch" })
    await fx.runtime.turnEnd({ eventId: "human-review" })
    const question = await fx.runtime.checkpoint({ action: "verdict", verdict: "needs-human", reason: "May I continue inside the existing boundary?" })
    assert.equal(question.ok, true)
    assert.ok(question.proposalId)
    assert.equal(fx.runtime.state().stage, "awaiting_human_approval")
    const approved = await fx.runtime.approve(question.proposalId)
    assert.equal(approved.ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.state().hardRevision, 0)
  } finally { fx.cleanup() }
})

test("invalid progress updates are atomic and cannot mark a phase ready", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    const result = await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }, { id: "nonexistent", status: "ready" }] })
    assert.equal(result.ok, false)
    assert.equal(fx.runtime.state().phases[0].todos[0].status, "pending")
  } finally { fx.cleanup() }
})

test("unexpected allowed paths and repeated no-progress calls route to Frontier without blocking ordinary tools", async () => {
  const expanded = fixture({ config: { scopeExpansionFactor: 2, milestoneReview: true } })
  try {
    await beginCheap(expanded)
    expanded.setFiles({ "src/a.mjs": "edited", "src/b.mjs": "created", "src/c.mjs": "created" })
    const result = await expanded.runtime.completeToolBatch({ eventId: "scope-batch" })
    assert.equal(result.routed, true)
    assert.equal(expanded.runtime.state().lastEscalationReason, "scope-expansion")
  } finally { expanded.cleanup() }

  const churn = fixture({ config: { toolChurnThreshold: 2, churnWindow: 2, milestoneReview: true } })
  try {
    await beginCheap(churn)
    for (let i = 0; i < 2; i++) {
      const id = `retry-${i}`
      assert.equal(churn.runtime.observeToolCall({ id, name: "bash", input: { command: "echo unchanged" } }), undefined)
      churn.runtime.observeToolResult({ id, name: "bash", isError: true })
    }
    await churn.runtime.completeToolBatch({ eventId: "churn-batch" })
    assert.equal(churn.runtime.state().lastEscalationReason, "churn")
  } finally { churn.cleanup() }
})

test("Cheap cannot author a hard-boundary proposal; invalid Frontier patches are rejected", async () => {
  const fx = fixture({ config: { milestoneReview: true } })
  try {
    await beginCheap(fx)
    const cheap = await fx.runtime.checkpoint({ action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "tests/"] } })
    assert.equal(cheap.requiresHuman, false)
    assert.equal(fx.runtime.state().proposals.filter((item) => item.kind === "hard").length, 0)
    assert.equal(fx.runtime.state().stage, "frontier_review_pending")
    await fx.runtime.turnEnd({ eventId: "scope-request" })
    const invalid = await fx.runtime.checkpoint({ action: "propose", kind: "hard", patch: { allowedPaths: "../outside" } })
    assert.equal(invalid.ok, false)
    assert.equal(fx.runtime.state().hardRevision, 0)
  } finally { fx.cleanup() }
})

test("initial proposal cannot place soft expected files outside its proposed hard boundary", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    const proposed = plan(fx.root)
    proposed.softPlan.expectedFiles = ["package.json"]
    const response = await fx.runtime.checkpoint({ action: "submit_plan", plan: proposed })
    assert.equal(response.ok, false)
    assert.equal(fx.runtime.state().stage, "frontier_plan")
  } finally { fx.cleanup() }
})

test("a deleted validation cwd is reported as unknown rather than throwing or running elsewhere", async () => {
  const fx = fixture()
  try {
    await beginCheap(fx)
    rmSync(fx.root, { recursive: true, force: true })
    const result = await fx.runtime.validate("test-1")
    assert.equal(result.status, "unknown")
    assert.equal(result.reason, "check-cwd-unavailable")
  } finally { fx.cleanup() }
})

test("a failed audit append leaves a durable stopped state when state entries still work", async () => {
  const entries = []
  const runtime = createPrewalkRuntime({ deps: {
    snapshot: async () => ({}),
    appendEntry: (type, data) => { if (type === "prewalk-audit") throw new Error("audit storage unavailable"); entries.push({ type, data }) },
  } })
  const result = await runtime.start({ runId: "audit-run", sessionId: "audit-session", workspace: tmpdir(), goal: "Safely stop", frontierModel: "f/m", cheapModel: "c/m" })
  assert.equal(result.ok, false)
  assert.equal(entries.at(-1).data.state.stage, "stopped")
  assert.match(entries.at(-1).data.state.stopReason, /persistence-failure/)
})

test("worktree observation failures never pretend that an empty snapshot is a successful check", async () => {
  const fx = fixture({ deps: { snapshot: async () => { throw new Error("Git is unavailable") } } })
  try {
    const result = await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "Need worktree observation", frontierModel: "f/m", cheapModel: "c/m" })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "worktree-snapshot-failed")
    assert.equal(fx.runtime.state(), undefined)
  } finally { fx.cleanup() }
})

test("unverified Frontier pass and invalid Cheap updates cannot bypass phase authority", async () => {
  const fx = fixture({ config: { milestoneReview: true } })
  try {
    await beginCheap(fx)
    assert.equal((await fx.runtime.checkpoint({ action: "progress", phaseId: "unknown", todos: [] })).ok, false)
    assert.equal((await fx.runtime.checkpoint({ action: "propose", kind: "soft", patch: { steps: ["skip"] } })).ok, false)
    assert.equal((await fx.runtime.checkpoint({ action: "finish" })).ok, false)
    assert.equal((await fx.runtime.validate("nonexistent")).reason, "unknown-check-id")
    const blocked = fx.runtime.observeToolCall({ id: "bad-path", name: "write", input: { path: "../outside.txt" } })
    assert.equal(blocked.block, true)
    fx.runtime.observeToolCall({ id: "blocked", name: "write", input: { path: join(fx.root, "package.json") } })
    await fx.runtime.completeToolBatch({ eventId: "unauthorized-batch" })
    await fx.runtime.turnEnd({ eventId: "unauthorized-turn" })
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", verdict: "pass", phaseId: "phase-1", sourceRevision: "outdated" })).reason, "stale-review-revision")
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", verdict: "pass", phaseId: "wrong" })).reason, "review-phase-mismatch")
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", verdict: "pass", phaseId: "phase-1" })).reason, "phase-evidence-incomplete-or-stale")
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", verdict: "unexpected", phaseId: "phase-1" })).reason, "invalid-verdict")
  } finally { fx.cleanup() }
})

test("extension-independent worktree snapshot baseline detects changed pre-dirty files", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "r", sessionId: "s", workspace: fx.root, goal: "g", frontierModel: "f/m", cheapModel: "c/m", baseline: { "src/dirty.mjs": "before" } })
    fx.setFiles({ "src/dirty.mjs": "after" })
    const diff = await fx.runtime.completeToolBatch({ eventId: "dirty-edit" })
    assert.equal(diff.changedFiles.includes("src/dirty.mjs"), true)
  } finally { fx.cleanup() }
})

test("terminal runs bypass tool blocking and ignore later usage, tool results, and routing events", async () => {
  const stopped = fixture()
  try {
    await beginCheap(stopped)
    assert.equal(stopped.runtime.observeToolCall({ id: "late-edit", name: "edit", input: { path: join(stopped.root, "src/a.mjs") } }), undefined)
    await stopped.runtime.cancel()
    const state = stopped.runtime.state()
    const entryCount = stopped.entries.length
    for (const [name, input] of [
      ["read", { path: "README.md" }],
      ["bash", { command: "printf normal" }],
      ["edit", { path: join(stopped.root, "src/a.mjs") }],
      ["write", { path: join(stopped.root, "src/a.mjs") }],
      ["prewalk_checkpoint", { action: "progress" }],
      ["prewalk_validate", { checkId: "test-1" }],
    ]) assert.equal(stopped.runtime.observeToolCall({ id: `after-off-${name}`, name, input }), undefined)
    stopped.runtime.observeToolResult({ id: "late-edit", name: "edit", isError: false })
    assert.equal(await stopped.runtime.recordUsage({ role: "assistant", usage: { input: 10, output: 20 } }), false)
    assert.equal((await stopped.runtime.turnEnd({ eventId: "late-turn", message: { role: "assistant", usage: { input: 10 } } })).action, "none")
    assert.equal((await stopped.runtime.turnStart({ eventId: "late-start" })).action, "none")
    assert.equal((await stopped.runtime.checkpoint({ eventId: "late-checkpoint", action: "cancel" })).reason, "run-not-active")
    await stopped.runtime.completeToolBatch({ eventId: "late-batch" })
    assert.equal(stopped.runtime.state().stage, "stopped")
    assert.equal(stopped.runtime.state().stopReason, "cancelled")
    assert.deepEqual(stopped.runtime.state().changed_files, state.changed_files)
    assert.deepEqual(stopped.runtime.state().usage, state.usage)
    assert.equal(stopped.runtime.state().stateRevision, state.stateRevision)
    await stopped.runtime.cancel()
    assert.equal(stopped.runtime.state().stopReason, "cancelled", "repeated cancellation must preserve the original stop history")
    assert.equal(stopped.entries.length, entryCount, "events after off must not persist into the stopped run")
  } finally { stopped.cleanup() }

  const complete = fixture({ config: { milestoneReview: false, finalReview: false } })
  try {
    await beginCheap(complete)
    await complete.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await complete.runtime.validate("test-1")
    await complete.runtime.completeToolBatch({ eventId: "complete-phase" })
    const proposal = complete.runtime.state().finalProposalId
    assert.ok(proposal)
    assert.equal((await complete.runtime.approve(proposal)).ok, true)
    const state = complete.runtime.state()
    const entryCount = complete.entries.length
    assert.equal(state.stage, "complete")
    assert.equal(complete.runtime.observeToolCall({ id: "after-complete", name: "write", input: { path: "src/a.mjs" } }), undefined)
    assert.equal(await complete.runtime.recordUsage({ role: "assistant", usage: { input: 1 } }), false)
    await complete.runtime.completeToolBatch({ eventId: "after-complete-batch" })
    assert.equal(complete.runtime.state().stage, "complete")
    assert.equal(complete.runtime.state().stateRevision, state.stateRevision)
    assert.equal((await complete.runtime.cancel()).action, "none")
    assert.equal(complete.runtime.state().stage, "complete", "off must not rewrite completed history")
    assert.equal(complete.entries.length, entryCount)
  } finally { complete.cleanup() }
})

test("off during an in-flight tool batch prevents queued work from reviving or persisting the run", async () => {
  let holdSnapshot = false
  let snapshotStarted
  let releaseSnapshot
  const started = new Promise((resolve) => { snapshotStarted = resolve })
  const pendingSnapshot = new Promise((resolve) => { releaseSnapshot = resolve })
  const fx = fixture({ deps: { snapshot: async () => {
    if (holdSnapshot) {
      holdSnapshot = false
      snapshotStarted()
      await pendingSnapshot
    }
    return {}
  } } })
  try {
    await beginCheap(fx)
    holdSnapshot = true
    const batch = fx.runtime.completeToolBatch({ eventId: "in-flight-batch" })
    await started
    await fx.runtime.cancel()
    const entryCount = fx.entries.length
    releaseSnapshot()
    await batch
    assert.equal(fx.runtime.state().stage, "stopped")
    assert.equal(fx.runtime.state().stopReason, "cancelled")
    assert.equal(fx.entries.length, entryCount)
  } finally {
    releaseSnapshot()
    fx.cleanup()
  }
})

test("off during model lookup prevents a queued model switch and routing persistence", async () => {
  let holdLookup = false
  let lookupStarted
  let releaseLookup
  const started = new Promise((resolve) => { lookupStarted = resolve })
  const pendingLookup = new Promise((resolve) => { releaseLookup = resolve })
  let switchCount = 0
  const fx = fixture({ config: { milestoneReview: true, finalReview: true }, deps: {
    findModel: async (model) => {
      if (holdLookup) {
        holdLookup = false
        lookupStarted()
        await pendingLookup
      }
      return model
    },
    setModel: async () => { switchCount++; return true },
  } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "route-before-off" })
    const switchesBeforeOff = switchCount
    holdLookup = true
    const routing = fx.runtime.turnEnd({ eventId: "route-during-off" })
    await started
    await fx.runtime.cancel()
    const entryCount = fx.entries.length
    releaseLookup()
    assert.equal((await routing).action, "none")
    assert.equal(fx.runtime.state().stage, "stopped")
    assert.equal(switchCount, switchesBeforeOff)
    assert.equal(fx.entries.length, entryCount)
  } finally {
    releaseLookup()
    fx.cleanup()
  }
})

test("initial proposal rejection waits for substantive feedback before returning to planning", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    const first = await fx.runtime.checkpoint({ action: "submit_plan", plan: plan(fx.root) })
    const proposal = fx.runtime.state().proposals.find((item) => item.id === first.proposalId)
    assert.equal((await fx.runtime.rejectProposal(first.proposalId, { baseRevision: "stale", feedback: "revise" })).ok, false)
    assert.equal(fx.runtime.state().stage, "awaiting_approval")
    assert.equal((await fx.runtime.rejectProposal(first.proposalId, { baseRevision: proposal.baseRevision, feedback: "  " })).ok, true)
    assert.equal(fx.runtime.state().stage, "awaiting_revision")
    assert.equal(fx.runtime.state().role, "frontier")
    assert.equal(fx.runtime.state().revisionRequest.feedback, "")
    assert.equal(fx.runtime.state().proposals.find((item) => item.id === first.proposalId).status, "rejected")
    assert.equal(fx.runtime.state().stopReason, null)
    assert.equal((await fx.runtime.provideRevisionFeedback("  ")).ok, false)
    assert.equal((await fx.runtime.checkpoint({ action: "submit_plan", plan: plan(fx.root) })).reason, "revision-feedback-required")
    assert.equal(fx.runtime.observeToolCall({ id: "revision-read", name: "read", input: { path: "README.md" } }), undefined)
    for (const [name, input] of [
      ["edit", { path: join(fx.root, "src/a.mjs") }],
      ["write", { path: join(fx.root, ".temp-local/workflow-plan.md") }],
      ["bash", { command: "printf no-implementation" }],
      ["prewalk_validate", { checkId: "test-1" }],
    ]) assert.equal(fx.runtime.observeToolCall({ id: `awaiting-feedback-${name}`, name, input })?.block, true)
    assert.equal((await fx.runtime.provideRevisionFeedback("Use a narrower scope")).ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_plan")
    assert.deepEqual(fx.runtime.state().revisionRequest, { kind: "initial", proposalId: first.proposalId, feedback: "Use a narrower scope" })
    const revisedPlan = { ...plan(fx.root), hardContract: { ...plan(fx.root).hardContract, outcome: "narrower scope" } }
    const revised = await fx.runtime.checkpoint({ action: "submit_plan", plan: revisedPlan })
    assert.equal(revised.ok, true)
    assert.equal(fx.runtime.state().revisionRequest, undefined)
    assert.equal(fx.runtime.state().proposals.find((item) => item.id === first.proposalId).status, "rejected")
    assert.equal((await fx.runtime.approve(revised.proposalId)).ok, true)
    assert.equal(fx.runtime.state().hardContract.outcome, "narrower scope")
  } finally { fx.cleanup() }
})

test("hard proposal rejection preserves the approved boundary until a revised proposal is approved", async () => {
  const fx = fixture({ config: { finalReview: false, milestoneReview: false } })
  try {
    await beginCheap(fx)
    fx.runtime.observeToolCall({ id: "scope-needed", name: "write", input: { path: "tests/new_test.mjs" } })
    await fx.runtime.completeToolBatch({ eventId: "scope-needed-batch" })
    await fx.runtime.turnEnd({ eventId: "scope-needed-turn" })
    const original = { ...fx.runtime.state().hardContract }
    const first = await fx.runtime.checkpoint({ action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "tests/"] } })
    const proposal = fx.runtime.state().proposals.find((item) => item.id === first.proposalId)
    assert.equal(fx.runtime.observeToolCall({ id: "hard-gate-edit", name: "edit", input: { path: join(fx.root, "src/a.mjs") } })?.block, true)
    assert.equal((await fx.runtime.rejectProposal(first.proposalId, { baseRevision: proposal.baseRevision, feedback: "Include only test files" })).ok, true)
    assert.equal(fx.runtime.state().stage, "awaiting_revision")
    assert.deepEqual(fx.runtime.state().hardContract, original)
    assert.equal((await fx.runtime.provideRevisionFeedback("Include only test files")).ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.state().revisionRequest.feedback, "Include only test files")
    const revised = await fx.runtime.checkpoint({ action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "tests/fixtures/"] } })
    assert.equal(revised.ok, true)
    assert.equal(fx.runtime.state().revisionRequest, undefined)
    assert.equal((await fx.runtime.approve(revised.proposalId)).ok, true)
    assert.deepEqual(fx.runtime.state().hardContract.allowedPaths, ["src/", "tests/fixtures/"])
  } finally { fx.cleanup() }
})

test("final proposal rejection removes the completion barrier and permits repair plus a fresh review", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: true } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-for-final" })
    await fx.runtime.turnEnd({ eventId: "final-review" })
    const passed = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    const rejectedProposal = fx.runtime.state().proposals.find((item) => item.id === passed.finalProposalId)
    assert.equal(fx.runtime.observeToolCall({ id: "final-gate-edit", name: "edit", input: { path: join(fx.root, "src/a.mjs") } })?.block, true)
    assert.equal((await fx.runtime.rejectProposal(passed.finalProposalId, { baseRevision: rejectedProposal.baseRevision, feedback: "Fix the implementation before completion" })).ok, true)
    assert.equal(fx.runtime.state().stage, "awaiting_revision")
    assert.equal(fx.runtime.state().finalProposalId, null)
    assert.deepEqual(fx.runtime.state().completed, [])
    assert.equal(fx.runtime.state().reviewRecords[`phase-1:${fx.runtime.state().planRevision}:${fx.runtime.state().sourceRevision}`], undefined)
    assert.equal((await fx.runtime.provideRevisionFeedback("Fix the implementation before completion")).ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "repair", pendingTodoIds: ["todo-1"] })).ok, true)
    assert.equal(fx.runtime.state().revisionRequest, undefined)
    await fx.runtime.turnEnd({ eventId: "return-to-cheap-after-rejection" })
    fx.setFiles({ "src/a.mjs": "repaired" })
    fx.runtime.observeToolCall({ id: "repair-edit", name: "edit", input: { path: join(fx.root, "src/a.mjs") } })
    fx.runtime.observeToolResult({ id: "repair-edit", name: "edit" })
    await fx.runtime.completeToolBatch({ eventId: "repair-edit-batch" })
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-after-repair" })
    await fx.runtime.turnEnd({ eventId: "fresh-final-review" })
    const freshPass = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    assert.equal(freshPass.ok, true)
    assert.notEqual(freshPass.finalProposalId, passed.finalProposalId)
    assert.equal(fx.runtime.state().stage, "awaiting_final_approval")
  } finally { fx.cleanup() }
})

test("awaiting-revision state restores and resumes on Frontier", async () => {
  const fx = fixture()
  try {
    await fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    const proposed = await fx.runtime.checkpoint({ action: "submit_plan", plan: plan(fx.root) })
    await fx.runtime.rejectProposal(proposed.proposalId)
    assert.equal(fx.runtime.state().revisionRequest.feedback, "")
    const restored = createPrewalkRuntime({ deps: { cwd: fx.root, getBranch: () => fx.entries, appendEntry: (type, data) => fx.entries.push({ type, data }), snapshot: async () => ({}) } })
    assert.equal((await restored.restore({ sessionId: "session-1", workspace: fx.root })).ok, true)
    assert.equal(restored.state().stage, "paused")
    assert.equal(restored.state().resumeStage, "awaiting_revision")
    assert.equal((await restored.resume()).ok, true)
    assert.equal(restored.state().stage, "awaiting_revision")
    assert.equal(restored.state().role, "frontier")
    assert.deepEqual(await restored.modelSelected("f/m"), { ok: true })
  } finally { fx.cleanup() }
})

test("off during the initial snapshot prevents a pending start from creating a run", async () => {
  let holdSnapshot = true
  let snapshotStarted
  let releaseSnapshot
  const started = new Promise((resolve) => { snapshotStarted = resolve })
  const pendingSnapshot = new Promise((resolve) => { releaseSnapshot = resolve })
  const fx = fixture({ deps: { snapshot: async () => {
    if (holdSnapshot) {
      holdSnapshot = false
      snapshotStarted()
      await pendingSnapshot
    }
    return {}
  } } })
  try {
    const starting = fx.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: fx.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    await started
    await fx.runtime.cancel()
    releaseSnapshot()
    const result = await starting
    assert.equal(result.ok, false)
    assert.equal(result.reason, "start-cancelled")
    assert.equal(fx.runtime.state(), undefined)
    assert.deepEqual(fx.entries, [])
  } finally {
    releaseSnapshot()
    fx.cleanup()
  }
})

test("off after model-switch persistence suppresses its queued continuation", async () => {
  const entries = []
  const messages = []
  let runtime
  let interceptSwitch = false
  let offPromise
  const fx = fixture({ config: { milestoneReview: true, finalReview: false }, deps: {
    appendEntry(type, data) {
      entries.push({ type, data })
      if (interceptSwitch && type === "prewalk-audit" && data.type === "model-switched") {
        interceptSwitch = false
        return new Promise((resolve) => queueMicrotask(() => {
          resolve()
          queueMicrotask(() => { offPromise = runtime.cancel() })
        }))
      }
    },
    sendMessage(message) { messages.push(message) },
  } })
  runtime = fx.runtime
  try {
    await beginCheap(fx)
    fx.runtime.observeToolCall({ id: "switch-review", name: "edit", input: { path: join(fx.root, "package.json") } })
    await fx.runtime.completeToolBatch({ eventId: "switch-review-batch" })
    await fx.runtime.turnEnd({ eventId: "switch-to-frontier" })
    const question = await fx.runtime.checkpoint({ action: "verdict", verdict: "continue", phaseId: "phase-1" })
    assert.equal(question.ok, true)
    const messagesBeforeOff = messages.length
    interceptSwitch = true
    const routed = await fx.runtime.turnEnd({ eventId: "switch-back-to-cheap" })
    await offPromise
    assert.equal(routed.action, "none")
    assert.equal(fx.runtime.state().stage, "stopped")
    assert.equal(fx.runtime.state().stopReason, "cancelled")
    assert.equal(messages.length, messagesBeforeOff)
  } finally { fx.cleanup() }
})

test("a repaired phase can pass again at the same revision after fresh validation", async () => {
  const fx = fixture({ config: { milestoneReview: true, finalReview: true } })
  try {
    await beginCheap(fx)
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    await fx.runtime.validate("test-1")
    await fx.runtime.completeToolBatch({ eventId: "ready-before-rejected-final" })
    await fx.runtime.turnEnd({ eventId: "first-final-review" })
    const firstPass = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    const proposal = fx.runtime.state().proposals.find((item) => item.id === firstPass.finalProposalId)
    await fx.runtime.rejectProposal(firstPass.finalProposalId, { baseRevision: proposal.baseRevision, feedback: "Review the repaired evidence again" })
    await fx.runtime.provideRevisionFeedback("Review the repaired evidence again")
    await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "repair", pendingTodoIds: ["todo-1"] })
    await fx.runtime.turnEnd({ eventId: "return-for-same-revision-repair" })

    const revision = fx.runtime.state().sourceRevision
    await fx.runtime.checkpoint({ action: "progress", phaseId: "phase-1", todos: [{ id: "todo-1", status: "ready" }] })
    const validation = await fx.runtime.validate("test-1")
    assert.equal(validation.status, "passed")
    assert.equal(validation.revision, revision)
    await fx.runtime.completeToolBatch({ eventId: "ready-after-same-revision-repair" })
    assert.equal(fx.runtime.state().stage, "frontier_review_pending")
    await fx.runtime.turnEnd({ eventId: "review-same-revision-repair" })
    const secondPass = await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })
    assert.equal(secondPass.ok, true)
    assert.equal(fx.runtime.state().reviewRecords[`phase-1:${fx.runtime.state().planRevision}:${revision}`].verdict, "pass")
    assert.equal((await fx.runtime.checkpoint({ action: "verdict", phaseId: "phase-1", verdict: "pass" })).reason, "frontier-verdict-not-allowed-in-this-stage")
  } finally { fx.cleanup() }
})

test("human question answers require the unique current decision and record the actual answer", async () => {
  const fx = fixture({ config: { milestoneReview: true } })
  try {
    const question = await requestHumanDecision(fx)
    const proposal = fx.runtime.state().proposals.find((item) => item.id === question.proposalId)
    assert.equal((await fx.runtime.answerQuestion(question.proposalId, "OK", { baseRevision: proposal.baseRevision })).reason, "substantive-answer-required")
    assert.equal((await fx.runtime.answerQuestion(question.proposalId, "Use the existing /v2 endpoint.", { baseRevision: "stale" })).reason, "stale-proposal")
    assert.equal(fx.runtime.state().stage, "awaiting_human_approval")

    const answer = "Use the existing /v2 endpoint; do not change the contract."
    const result = await fx.runtime.answerQuestion(question.proposalId, answer, { baseRevision: proposal.baseRevision })
    assert.equal(result.ok, true)
    assert.equal(fx.runtime.state().stage, "frontier_review")
    assert.equal(fx.runtime.state().role, "frontier")
    assert.equal(fx.runtime.state().humanQuestion, undefined)
    assert.equal(fx.runtime.state().proposals.find((item) => item.id === question.proposalId).status, "answered")
    assert.equal(fx.runtime.state().proposals.find((item) => item.id === question.proposalId).answer, answer)
    assert.equal(fx.runtime.state().important_decisions.at(-1).reason, answer)
    assert.equal(fx.runtime.state().important_decisions.at(-1).question, proposal.patch.question)
  } finally { fx.cleanup() }
})

test("human question answers reject ambiguous decisions and cannot reopen a run after off", async () => {
  const ambiguous = fixture({ config: { milestoneReview: true } })
  try {
    const question = await requestHumanDecision(ambiguous)
    const state = ambiguous.runtime.state()
    const decision = state.proposals.find((item) => item.id === question.proposalId)
    state.stateRevision += 1
    state.proposals.push({ ...decision, id: "duplicate-pending-decision", status: "pending" })
    ambiguous.entries.push({ type: "prewalk-state", data: { version: 1, state } })
    const restored = createPrewalkRuntime({ deps: {
      cwd: ambiguous.root,
      getBranch: () => ambiguous.entries,
      appendEntry: (type, data) => ambiguous.entries.push({ type, data }),
      snapshot: async () => ({}),
    } })
    assert.equal((await restored.restore({ sessionId: "session-1", workspace: ambiguous.root })).ok, true)
    assert.equal((await restored.resume()).ok, true)
    assert.equal((await restored.answerQuestion(question.proposalId, "Use endpoint A.", { baseRevision: decision.baseRevision })).reason, "ambiguous-proposal")
    assert.equal(restored.state().stage, "awaiting_human_approval")
  } finally { ambiguous.cleanup() }

  const off = fixture({ config: { milestoneReview: true } })
  try {
    const question = await requestHumanDecision(off)
    await off.runtime.cancel()
    assert.equal((await off.runtime.answerQuestion(question.proposalId, "Use endpoint A.")).reason, "run-not-active")
    assert.equal(off.runtime.state().stage, "stopped")
  } finally { off.cleanup() }
})

test("proposal rejection requires unique pending identity and the current hard revision", async () => {
  const ambiguous = fixture()
  try {
    await ambiguous.runtime.start({ runId: "run-1", sessionId: "session-1", workspace: ambiguous.root, goal: "goal", frontierModel: "f/m", cheapModel: "c/m" })
    const initial = await ambiguous.runtime.checkpoint({ action: "submit_plan", plan: plan(ambiguous.root) })
    const state = ambiguous.runtime.state()
    const proposal = state.proposals.find((item) => item.id === initial.proposalId)
    state.stateRevision += 1
    state.proposals.push({ ...proposal, id: "other-kind-proposal", kind: "hard", status: "pending" })
    ambiguous.entries.push({ type: "prewalk-state", data: { version: 1, state } })
    const restored = createPrewalkRuntime({ deps: {
      cwd: ambiguous.root,
      getBranch: () => ambiguous.entries,
      appendEntry: (type, data) => ambiguous.entries.push({ type, data }),
      snapshot: async () => ({}),
    } })
    await restored.restore({ sessionId: "session-1", workspace: ambiguous.root })
    await restored.resume()
    assert.equal((await restored.rejectProposal(initial.proposalId, { baseRevision: proposal.baseRevision })).reason, "proposal-not-current")
  } finally { ambiguous.cleanup() }

  const staleHardRevision = fixture({ config: { finalReview: false, milestoneReview: false } })
  try {
    await beginCheap(staleHardRevision)
    staleHardRevision.runtime.observeToolCall({ id: "scope-review", name: "edit", input: { path: join(staleHardRevision.root, "package.json") } })
    await staleHardRevision.runtime.completeToolBatch({ eventId: "scope-review-batch" })
    await staleHardRevision.runtime.turnEnd({ eventId: "scope-review-turn" })
    const pending = await staleHardRevision.runtime.checkpoint({ action: "propose", kind: "hard", patch: { allowedPaths: ["src/", "tests/"] } })
    const state = staleHardRevision.runtime.state()
    state.stateRevision += 1
    state.hardRevision += 1
    staleHardRevision.entries.push({ type: "prewalk-state", data: { version: 1, state } })
    const restored = createPrewalkRuntime({ deps: {
      cwd: staleHardRevision.root,
      getBranch: () => staleHardRevision.entries,
      appendEntry: (type, data) => staleHardRevision.entries.push({ type, data }),
      snapshot: async () => ({}),
    } })
    await restored.restore({ sessionId: "session-1", workspace: staleHardRevision.root })
    await restored.resume()
    assert.equal((await restored.rejectProposal(pending.proposalId, { baseRevision: state.sourceRevision })).reason, "stale-proposal")
  } finally { staleHardRevision.cleanup() }
})
