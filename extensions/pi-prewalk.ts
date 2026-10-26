import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "@earendil-works/pi-ai"
import { createPrewalkState, parsePrewalkArgs, parsePrewalkConfig } from "./prewalk-core.mjs"

type PrewalkConfig = { firstModel: string; secondModel: string }
type WorkspaceRecord = { sessionId: string; workspaceDir: string }
const WORKSPACE_ENTRY_TYPE = "prewalk-workspace"

function validateWorkspace(directory: string, projectDirectory: string) {
  const project = realpathSync(projectDirectory)
  const temporaryRoot = join(project, ".temp-local")
  const requestedRoot = join(temporaryRoot, "sessions")
  for (const [path, label] of [[temporaryRoot, "temporary directory"], [requestedRoot, "session workspace root"]]) {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`The ${label} must not be a symbolic link.`)
    }
  }
  const root = realpathSync(requestedRoot)
  const rootRelative = relative(project, root)
  if (!rootRelative || isAbsolute(rootRelative) || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
    throw new Error("The session workspace root must remain inside this project.")
  }
  const requestedWorkspace = resolve(directory)
  const workspace = realpathSync(requestedWorkspace)
  if (workspace !== requestedWorkspace || dirname(workspace) !== root) {
    throw new Error("The recorded path must be the actual workspace directory directly inside the sessions root.")
  }
  const remainder = relative(root, workspace)
  if (!remainder || isAbsolute(remainder) || remainder === ".." || remainder.startsWith(`..${sep}`)) {
    throw new Error("The recorded workspace must be inside this project's .temp-local/sessions directory.")
  }
  return workspace
}

const harnessRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))

function findModel(ctx: ExtensionContext, modelRef: string) {
  const [provider, ...modelParts] = modelRef.split("/")
  return ctx.modelRegistry.find(provider, modelParts.join("/"))
}

function getModelRef(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`
}

function readLocalConfig(): PrewalkConfig | undefined {
  const configPath = join(harnessRoot, "prewalk.json")
  if (!existsSync(configPath)) return undefined
  return parsePrewalkConfig(JSON.parse(readFileSync(configPath, "utf8")))
}

export default function (pi: ExtensionAPI) {
  const state = createPrewalkState()
  let workspaceRecord: WorkspaceRecord | undefined

  pi.registerTool({
    name: "prewalk_workspace",
    label: "Prewalk workspace",
    description: "Reserve this session's scratch workspace before writing any files. Choose a meaningful short lowercase English task description, even for a Japanese request. Repeated calls reuse the same folder.",
    parameters: Type.Object({
      description: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64, description: "Short English task slug, for example plan-isolation." }),
    }),
    executionMode: "sequential",
    async execute(_id, { description }, _signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId()
      if (workspaceRecord && workspaceRecord.sessionId !== sessionId) {
        throw new Error("The session changed before its workspace was restored. Start the current session again.")
      }
      if (!workspaceRecord) {
        // The installed extension is symlinked; resolve the helper from the canonical harness root.
        const { createSessionWorkspace } = await import(pathToFileURL(join(harnessRoot, "skills/planning/scripts/session-workspace.mjs")).href)
        const workspaceDir = createSessionWorkspace(ctx.cwd, description)
        const record = { sessionId, workspaceDir }
        pi.appendEntry(WORKSPACE_ENTRY_TYPE, record)
        workspaceRecord = record
      }
      state.bindWorkspace(validateWorkspace(workspaceRecord.workspaceDir, ctx.cwd), ctx.cwd)
      const details = { workspaceDir: state.workspace(), planPath: state.planPath() }
      return { content: [{ type: "text", text: JSON.stringify(details) }], details }
    },
  })

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

  pi.on("session_start", (_event, ctx) => {
    state.disarm()
    state.bindWorkspace(undefined, ctx.cwd)
    workspaceRecord = undefined
    const sessionId = ctx.sessionManager.getSessionId()
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== WORKSPACE_ENTRY_TYPE) continue
      const record = entry.data as Partial<WorkspaceRecord> | undefined
      // Forked sessions inherit entries but have a different ID and need a new folder.
      if (record?.sessionId === sessionId && typeof record.workspaceDir === "string") {
        workspaceRecord = { sessionId, workspaceDir: record.workspaceDir }
      }
    }
    if (workspaceRecord) {
      try {
        state.bindWorkspace(validateWorkspace(workspaceRecord.workspaceDir, ctx.cwd), ctx.cwd)
      } catch (error) {
        ctx.ui.notify(`Prewalk: could not restore this session's workspace: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }
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
        `Continue from the existing conversation and the exact plan ${state.planPath()}. Do not repeat broad exploration. Implement and verify the remaining work, updating the plan as items are completed. Keep all scratch files in ${state.workspace()}.`,
        "Workflow plan headings, explanatory prose, and diagram labels use Japanese; paths, commands, and code identifiers retain their original form.",
      ].join("\n\n"),
      display: true,
      details: { firstModel: config.firstModel, secondModel: config.secondModel, workspaceDir: state.workspace(), planPath: state.planPath() },
    }, { deliverAs: "steer", triggerTurn: true })

    ctx.ui.notify(`Prewalk: switched to ${config.secondModel}`, "info")
  })

  pi.on("before_agent_start", (event) => {
    const instructions: string[] = []
    if (state.workspace()) {
      instructions.push(`This session's workspace is ${state.workspace()}. Its exact workflow plan is ${state.planPath()}. Keep all scratch files in this workspace, retain these paths across handoffs and compaction, and never select a different session's plan or a latest plan automatically. An idle Prewalk does not resume earlier work without an explicit request.`)
    }
    if (state.stage() === "frontier") {
      instructions.push(
        "Prewalk is armed. You are the frontier pass.",
        state.workspace()
          ? `Inspect only what is necessary, then write a concrete plan to ${state.planPath()}.`
          : "First call prewalk_workspace with a meaningful short lowercase English task description (for example plan-isolation), even if the task is in Japanese. Use the returned exact workspace and plan paths. No file mutations are permitted until the workspace is allocated. Inspect only what is necessary, then write a concrete plan to its returned planPath.",
        "Workflow plan headings, explanatory prose, and diagram labels use Japanese; paths, commands, and code identifiers retain their original form.",
        "After the plan, make exactly one source-code edit or write outside .temp-local/. Do not try to finish the task; the worker model will continue in this same session immediately after that first code mutation.",
      )
    } else if (state.stage() === "worker") {
      instructions.push("Prewalk handoff is complete. Continue implementing from the existing plan and conversation; verify the work before reporting completion.")
    }
    if (instructions.length > 0) return { systemPrompt: `${event.systemPrompt}\n\n${instructions.join(" ")}` }
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
        ctx.ui.notify(`Prewalk: invalid local config (prewalk.json in the harness directory): ${error instanceof Error ? error.message : String(error)}`, "error")
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
