import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createPrewalkState, parsePrewalkArgs, PREWALK_PLAN_PATH } from "./prewalk-core.mjs"

function findModel(ctx: ExtensionContext, modelRef: string) {
  const [provider, ...modelParts] = modelRef.split("/")
  return ctx.modelRegistry.find(provider, modelParts.join("/"))
}

function getModelRef(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`
}

export default function (pi: ExtensionAPI) {
  const state = createPrewalkState()

  async function arm(config: { frontier: string; worker: string }, ctx: ExtensionContext) {
    const frontier = findModel(ctx, config.frontier)
    const worker = findModel(ctx, config.worker)
    if (!frontier) {
      ctx.ui.notify(`Prewalk: frontier model "${config.frontier}" is unavailable`, "error")
      return false
    }
    if (!worker) {
      ctx.ui.notify(`Prewalk: worker model "${config.worker}" is unavailable`, "error")
      return false
    }

    const switched = await pi.setModel(frontier)
    if (!switched) {
      ctx.ui.notify(`Prewalk: could not authenticate frontier model "${config.frontier}"`, "error")
      return false
    }

    state.arm(config)
    ctx.ui.notify(`Prewalk armed: ${config.frontier} -> ${config.worker}`, "info")
    return true
  }

  pi.on("session_start", () => {
    state.disarm()
  })

  pi.on("tool_call", (event) => state.observeToolCall(event.toolCallId, event.toolName, event.input))

  pi.on("tool_result", (event) => {
    state.observeToolResult(event.toolCallId, event.isError)
  })

  pi.on("model_select", (event, ctx) => {
    const config = state.config()
    if (!config) return

    const expected = state.stage() === "frontier" ? config.frontier : config.worker
    if (getModelRef(event.model) === expected) return

    state.disarm()
    ctx.ui.notify(`Prewalk disarmed after model changed to ${getModelRef(event.model)}`, "warning")
  })

  pi.on("agent_settled", () => {
    if (state.stage() === "worker") state.finish()
  })

  pi.on("turn_end", async (_event, ctx) => {
    if (!state.readyToHandoff()) return

    const config = state.config()
    if (!config || !state.beginHandoff()) return

    const worker = findModel(ctx, config.worker)
    if (!worker) {
      state.completeHandoff(false)
      ctx.ui.notify(`Prewalk: worker model "${config.worker}" is unavailable`, "error")
      return
    }

    const switched = await pi.setModel(worker)
    state.completeHandoff(switched)
    if (!switched) {
      ctx.ui.notify(`Prewalk: could not authenticate worker model "${config.worker}"`, "error")
      return
    }

    pi.sendMessage({
      customType: "prewalk-handoff",
      content: [
        "PREWALK HANDOFF",
        `The frontier model completed planning and the first code mutation. You are now the worker model (${config.worker}).`,
        `Continue from the existing conversation and ${PREWALK_PLAN_PATH}. Do not repeat broad exploration. Implement and verify the remaining work, updating the plan as items are completed. Keep scratch files in .temp-local/.`,
      ].join("\n\n"),
      display: true,
      details: { frontier: config.frontier, worker: config.worker },
    }, { deliverAs: "steer", triggerTurn: true })

    ctx.ui.notify(`Prewalk: switched to ${config.worker}`, "info")
  })

  pi.on("before_agent_start", (event) => {
    if (state.stage() === "frontier") {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + [
          "Prewalk is armed. You are the frontier pass.",
          `Inspect only what is necessary, then write a concrete plan to ${PREWALK_PLAN_PATH}. Create .temp-local/ if needed and keep all scratch files there.`,
          "After the plan, make exactly one source-code edit or write outside .temp-local/. Do not try to finish the task; the worker model will continue in this same session immediately after that first code mutation.",
        ].join(" "),
      }
    }

    if (state.stage() === "worker") {
      return {
        systemPrompt: event.systemPrompt + "\n\nPrewalk handoff is complete. Continue implementing from the existing plan and conversation; verify the work before reporting completion.",
      }
    }
  })

  pi.registerCommand("prewalk", {
    description: "Frontier plans and makes one edit, then GLM worker continues. /prewalk [worker] | [frontier worker] | off",
    handler: async (args, ctx) => {
      if (args.trim() === "off") {
        state.disarm()
        ctx.ui.notify("Prewalk disarmed", "info")
        return
      }

      try {
        await arm(parsePrewalkArgs(args), ctx)
      } catch (error) {
        ctx.ui.notify(`Prewalk: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    },
  })
}
