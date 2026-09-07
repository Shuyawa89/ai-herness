import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createPrewalkState, parsePrewalkArgs, parsePrewalkConfig, PREWALK_PLAN_PATH } from "./prewalk-core.mjs"

type PrewalkConfig = { firstModel: string; secondModel: string }

function findModel(ctx: ExtensionContext, modelRef: string) {
  const [provider, ...modelParts] = modelRef.split("/")
  return ctx.modelRegistry.find(provider, modelParts.join("/"))
}

function getModelRef(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`
}

function readLocalConfig(): PrewalkConfig | undefined {
  const configPath = join(getAgentDir(), "prewalk.json")
  if (!existsSync(configPath)) return undefined
  return parsePrewalkConfig(JSON.parse(readFileSync(configPath, "utf8")))
}

export default function (pi: ExtensionAPI) {
  const state = createPrewalkState()

  async function arm(config: PrewalkConfig, ctx: ExtensionContext) {
    const first = findModel(ctx, config.firstModel)
    const second = findModel(ctx, config.secondModel)
    if (!first) {
      ctx.ui.notify(`Prewalk: first model "${config.firstModel}" is unavailable`, "error")
      return false
    }
    if (!second) {
      ctx.ui.notify(`Prewalk: second model "${config.secondModel}" is unavailable`, "error")
      return false
    }

    const switched = await pi.setModel(first)
    if (!switched) {
      ctx.ui.notify(`Prewalk: could not authenticate first model "${config.firstModel}"`, "error")
      return false
    }

    state.arm(config)
    ctx.ui.notify(`Prewalk armed: ${config.firstModel} -> ${config.secondModel}`, "info")
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

    const expected = state.stage() === "frontier" ? config.firstModel : config.secondModel
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

    const second = findModel(ctx, config.secondModel)
    if (!second) {
      state.completeHandoff(false)
      ctx.ui.notify(`Prewalk: second model "${config.secondModel}" is unavailable`, "error")
      return
    }

    const switched = await pi.setModel(second)
    state.completeHandoff(switched)
    if (!switched) {
      ctx.ui.notify(`Prewalk: could not authenticate second model "${config.secondModel}"`, "error")
      return
    }

    pi.sendMessage({
      customType: "prewalk-handoff",
      content: [
        "PREWALK HANDOFF",
        `The frontier model completed planning and the first code mutation. You are now the worker model (${config.secondModel}).`,
        `Continue from the existing conversation and ${PREWALK_PLAN_PATH}. Do not repeat broad exploration. Implement and verify the remaining work, updating the plan as items are completed. Keep scratch files in .temp-local/.`,
      ].join("\n\n"),
      display: true,
      details: { firstModel: config.firstModel, secondModel: config.secondModel },
    }, { deliverAs: "steer", triggerTurn: true })

    ctx.ui.notify(`Prewalk: switched to ${config.secondModel}`, "info")
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
    description: "Frontier plans and makes one edit, then the configured second model continues. /prewalk [second] | [first second] | off",
    handler: async (args, ctx) => {
      if (args.trim() === "off") {
        state.disarm()
        ctx.ui.notify("Prewalk disarmed", "info")
        return
      }

      // Fully explicit arguments need no local config, so a broken prewalk.json
      // cannot block a one-off override.
      if (args.trim().split(/\s+/).length >= 2) {
        try {
          await arm(parsePrewalkArgs(args), ctx)
        } catch (error) {
          ctx.ui.notify(`Prewalk: ${error instanceof Error ? error.message : String(error)}`, "error")
        }
        return
      }

      let localConfig: PrewalkConfig | undefined
      try {
        localConfig = readLocalConfig()
      } catch (error) {
        ctx.ui.notify(`Prewalk: invalid local config (~/.pi/agent/prewalk.json): ${error instanceof Error ? error.message : String(error)}`, "error")
        return
      }

      try {
        await arm(parsePrewalkArgs(args, localConfig), ctx)
      } catch (error) {
        ctx.ui.notify(`Prewalk: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    },
  })
}
