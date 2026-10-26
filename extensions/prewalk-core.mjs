import { readlinkSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const FRONTIER_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "prewalk_workspace"])

function validateModelRef(value) {
  const [provider, ...modelParts] = value.split("/")
  if (/\s/.test(value) || !provider || modelParts.length === 0 || modelParts.some((part) => !part)) {
    throw new Error(`Expected a provider/model ID, received "${value}"`)
  }
  return value
}

function canonicalPath(path, followedLinks = 0) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    let target
    try {
      target = readlinkSync(absolute)
    } catch (linkError) {
      if (linkError.code !== "ENOENT" && linkError.code !== "EINVAL") throw linkError
    }
    if (target !== undefined) {
      if (followedLinks >= 40) throw new Error("Too many symbolic links in mutation path.")
      return canonicalPath(resolve(dirname(absolute), target), followedLinks + 1)
    }
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(canonicalPath(parent, followedLinks), relative(parent, absolute))
  }
}

function isWithin(path, directory) {
  const remainder = relative(directory, path)
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))
}

export function parsePrewalkConfig(settings) {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("Local Prewalk config must be a JSON object")
  }

  const { first_model: firstModel, second_model: secondModel } = settings
  if (typeof firstModel !== "string" || firstModel.trim() === "") {
    throw new Error("Local Prewalk config requires first_model as a provider/model ID")
  }
  if (typeof secondModel !== "string" || secondModel.trim() === "") {
    throw new Error("Local Prewalk config requires second_model as a provider/model ID")
  }

  return { firstModel: validateModelRef(firstModel.trim()), secondModel: validateModelRef(secondModel.trim()) }
}

export function parsePrewalkArgs(args, config) {
  const parts = args.trim() === "" ? [] : args.trim().split(/\s+/)

  if (parts.length > 2) {
    throw new Error("Prewalk expects zero, one, or two model IDs")
  }

  if (parts.length === 0) {
    if (!config) {
      throw new Error("Prewalk needs a local Prewalk config (prewalk.json in the harness directory) or explicit model arguments")
    }
    return { firstModel: config.firstModel, secondModel: config.secondModel }
  }

  if (parts.length === 1) {
    if (!config) {
      throw new Error("Prewalk needs a local Prewalk config (prewalk.json in the harness directory) or explicit model arguments")
    }
    return { firstModel: config.firstModel, secondModel: validateModelRef(parts[0]) }
  }

  return { firstModel: validateModelRef(parts[0]), secondModel: validateModelRef(parts[1]) }
}

export function isScratchPath(path, projectDirectory = process.cwd()) {
  const project = canonicalPath(projectDirectory)
  const absolute = resolve(project, path)
  const scratch = join(project, ".temp-local")
  const spelledScratch = resolve(projectDirectory, ".temp-local")
  const canonical = canonicalPath(absolute)
  return isWithin(absolute, scratch) || isWithin(absolute, spelledScratch)
    || isWithin(canonical, canonicalPath(scratch)) || isWithin(canonical, canonicalPath(join(scratch, "sessions")))
}

export function isPlanPath(path, workspaceDirectory, projectDirectory = process.cwd()) {
  if (!workspaceDirectory) return false
  return canonicalPath(resolve(projectDirectory, path)) === join(canonicalPath(workspaceDirectory), "workflow-plan.md")
}

function isMutation(toolName, input) {
  return (toolName === "edit" || toolName === "write") && typeof input.path === "string" && input.path.trim() !== ""
}

export function createPrewalkState({ projectDirectory = process.cwd() } = {}) {
  let projectSpelling = resolve(projectDirectory)
  let project = canonicalPath(projectDirectory)
  let workspace
  let currentStage = "idle"
  let config
  let planWritten = false
  let codeMutationApplied = false
  const pendingPlans = new Set()
  let pendingCodeMutation

  return {
    bindWorkspace(directory, projectDirectory = projectSpelling) {
      projectSpelling = resolve(projectDirectory)
      project = canonicalPath(projectDirectory)
      workspace = directory ? canonicalPath(directory) : undefined
    },

    workspace() {
      return workspace
    },

    planPath() {
      return workspace ? join(workspace, "workflow-plan.md") : undefined
    },

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
          reason: "Prewalk frontier pass permits only read, grep, find, ls, edit, write, and prewalk_workspace tools.",
        }
      }

      if (!isMutation(toolName, input)) return undefined

      if (!workspace) {
        return { block: true, reason: "Prewalk requires prewalk_workspace to allocate this session's workspace before any file mutation." }
      }

      try {
        const absolute = resolve(project, input.path)
        const canonical = canonicalPath(absolute)
        if (isScratchPath(input.path, projectSpelling)) {
          // Resolve even dangling symlinks so scratch cannot mutate another session's files.
          if (!isWithin(canonical, workspace)) {
            return { block: true, reason: `Prewalk scratch writes must remain in this session's workspace (${workspace}).` }
          }
          if (isPlanPath(input.path, workspace, project)) pendingPlans.add(toolCallId)
          return undefined
        }
      } catch (error) {
        return { block: true, reason: `Prewalk could not safely resolve the mutation path: ${error.message}` }
      }

      if (!planWritten) {
        return {
          block: true,
          reason: `Prewalk requires a successful plan file first (${this.planPath()}).`,
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
