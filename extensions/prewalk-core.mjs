export const DEFAULT_FRONTIER_MODEL = "openai-codex/gpt-5.6-sol"
export const DEFAULT_WORKER_MODEL = "openrouter/z-ai/glm-5.3-flash"
export const PREWALK_PLAN_PATH = ".temp-local/workflow-plan.md"

const FRONTIER_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"])

function validateModelRef(value) {
  const [provider, ...modelParts] = value.split("/")
  if (!provider || modelParts.length === 0 || modelParts.some((part) => !part)) {
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

export function parsePrewalkArgs(args) {
  const parts = args.trim() === "" ? [] : args.trim().split(/\s+/)

  if (parts.length > 2) {
    throw new Error("Prewalk expects zero, one, or two model IDs")
  }

  if (parts.length === 0) {
    return { frontier: DEFAULT_FRONTIER_MODEL, worker: DEFAULT_WORKER_MODEL }
  }

  if (parts.length === 1) {
    return { frontier: DEFAULT_FRONTIER_MODEL, worker: validateModelRef(parts[0]) }
  }

  return { frontier: validateModelRef(parts[0]), worker: validateModelRef(parts[1]) }
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

export function createPrewalkState() {
  let currentStage = "idle"
  let config
  let planWritten = false
  let codeMutationApplied = false
  const pendingPlans = new Set()
  let pendingCodeMutation

  return {
    arm(nextConfig) {
      currentStage = "frontier"
      config = nextConfig
      planWritten = false
      codeMutationApplied = false
      pendingPlans.clear()
      pendingCodeMutation = undefined
    },

    disarm() {
      currentStage = "idle"
      config = undefined
      planWritten = false
      codeMutationApplied = false
      pendingPlans.clear()
      pendingCodeMutation = undefined
    },

    finish() {
      this.disarm()
    },

    stage() {
      return currentStage
    },

    config() {
      return config
    },

    observeToolCall(toolCallId, toolName, input) {
      if (currentStage !== "frontier") return undefined

      if (!FRONTIER_ALLOWED_TOOLS.has(toolName)) {
        return {
          block: true,
          reason: "Prewalk frontier pass permits only read, grep, find, ls, edit, and write tools.",
        }
      }

      if (!isMutation(toolName, input)) return undefined

      if (isScratchPath(input.path)) {
        if (isPlanPath(input.path)) pendingPlans.add(toolCallId)
        return undefined
      }

      if (!planWritten) {
        return {
          block: true,
          reason: `Prewalk requires a successful plan file first (${PREWALK_PLAN_PATH}).`,
        }
      }

      if (codeMutationApplied || pendingCodeMutation) {
        return {
          block: true,
          reason: "Prewalk permits one code mutation before switching to the worker model.",
        }
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

    readyToHandoff() {
      return currentStage === "frontier" && codeMutationApplied
    },

    beginHandoff() {
      if (!this.readyToHandoff()) return false
      currentStage = "handoff"
      return true
    },

    completeHandoff(success) {
      currentStage = success ? "worker" : "idle"
    },
  }
}
