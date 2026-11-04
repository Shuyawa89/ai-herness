import { execFileSync, spawnSync } from "node:child_process"
import { closeSync, lstatSync, openSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const COMMAND_TIMEOUT_MS = 3_000
const GIT_TIMEOUT_MS = 1_500
const PLUGIN_ID = "herdr-file-viewer"
const ENTRYPOINT_ID = "file-viewer"
const MARKER_NAME = ".workflow-plan-viewer-opened"
const USAGE = "Usage: node show-workflow-plan.mjs [--diagnose | --retry] <absolute-workflow-plan.md>"
const HELP = `${USAGE}

Options:
  --diagnose  Check prerequisites without opening a pane.
  --retry     Explicitly open another split after a prior invocation. Check first:
              a timed-out launch may still have succeeded.
Opt out by setting HERDR_WORKFLOW_PLAN_VIEWER=off.
`

class Skip extends Error {}

function parseArguments(args) {
  let diagnose = false
  let retry = false
  const positional = []
  for (const arg of args) {
    if (arg === "--diagnose") diagnose = true
    else if (arg === "--retry") retry = true
    else if (arg === "--help" || arg === "-h") return { help: true }
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 1) throw new Error("Exactly one plan path is required.")
  if (diagnose && retry) throw new Error("--diagnose and --retry cannot be combined.")
  return { diagnose, retry, planPath: positional[0] }
}

function isOptedOut() {
  return /^(?:0|false|no|off)$/i.test(process.env.HERDR_WORKFLOW_PLAN_VIEWER ?? "")
}

function validatePlanPath(planPath) {
  if (!isAbsolute(planPath) || resolve(planPath) !== planPath) {
    throw new Skip("plan path must be a canonical absolute path")
  }
  if (basename(planPath) !== "workflow-plan.md") {
    throw new Skip("target is not named workflow-plan.md")
  }

  let info
  try {
    info = lstatSync(planPath)
  } catch {
    throw new Skip("plan file does not exist")
  }
  if (!info.isFile()) throw new Skip("plan must be a regular, non-symlink file")

  let canonical
  try {
    canonical = realpathSync(planPath)
  } catch {
    throw new Skip("plan path cannot be resolved")
  }
  if (canonical !== planPath) throw new Skip("plan path contains a symlink")

  const workspace = dirname(planPath)
  const sessions = dirname(workspace)
  const temporary = dirname(sessions)
  if (
    basename(temporary) !== ".temp-local"
    || basename(sessions) !== "sessions"
  ) {
    throw new Skip("plan is not directly inside a session workspace")
  }
  return { planPath, workspace, projectDirectory: dirname(temporary) }
}

function runJsonCommand(args, label) {
  let output
  try {
    output = execFileSync(process.env.HERDR_BIN_PATH || "herdr", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    const status = error?.code === "ETIMEDOUT" ? "timed out" : "failed"
    throw new Skip(`${label} ${status}`)
  }
  try {
    return JSON.parse(output)
  } catch {
    throw new Skip(`${label} returned invalid JSON`)
  }
}

function payloadOf(response) {
  return response?.result ?? response
}

function verifyHerdrEnvironment() {
  if (process.platform === "win32") throw new Skip("targeted plugin panes are unsupported on native Windows")
  if (process.env.HERDR_ENV !== "1") throw new Skip("HERDR_ENV must equal 1")
  const paneId = process.env.HERDR_PANE_ID
  if (!paneId) throw new Skip("HERDR_PANE_ID is missing")

  const status = runJsonCommand(["status", "--json"], "Herdr status check")
  if (status?.server?.running !== true || status?.server?.compatible !== true) {
    throw new Skip("Herdr server is unavailable or incompatible")
  }

  const pluginResponse = runJsonCommand(["plugin", "list", "--json"], "plugin check")
  const plugins = payloadOf(pluginResponse)?.plugins
  const plugin = Array.isArray(plugins) ? plugins.find((entry) => entry?.plugin_id === PLUGIN_ID) : undefined
  if (!plugin) throw new Skip(`${PLUGIN_ID} is not installed`)
  if (plugin.enabled !== true) throw new Skip(`${PLUGIN_ID} is disabled`)
  const platform = process.platform === "darwin" ? "macos" : process.platform
  if (!Array.isArray(plugin.platforms) || !plugin.platforms.includes(platform)) {
    throw new Skip(`${PLUGIN_ID} does not support this platform`)
  }

  const paneResponse = runJsonCommand(["pane", "current", "--current"], "current pane check")
  const pane = payloadOf(paneResponse)?.pane
  if (!pane || pane.pane_id !== paneId) throw new Skip("current pane does not match HERDR_PANE_ID")
  if (pane.focused !== true) throw new Skip("the caller pane is not focused")
  if (process.env.HERDR_WORKSPACE_ID && pane.workspace_id !== process.env.HERDR_WORKSPACE_ID) {
    throw new Skip("current pane belongs to a different Herdr workspace")
  }
  if (process.env.HERDR_TAB_ID && pane.tab_id !== process.env.HERDR_TAB_ID) {
    throw new Skip("current pane belongs to a different Herdr tab")
  }
  if (typeof pane.cwd !== "string" || !isAbsolute(pane.cwd)) {
    throw new Skip("current pane cwd is unavailable")
  }
  return { paneId, pane }
}

function rootForDirectory(directory) {
  let canonicalDirectory
  try {
    canonicalDirectory = realpathSync(directory)
    if (!statSync(canonicalDirectory).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new Skip("pane working directory cannot be resolved")
  }

  const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
  ]) delete gitEnvironment[key]

  const result = spawnSync("git", [
    "-C", canonicalDirectory,
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "rev-parse", "--show-toplevel",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnvironment,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error?.code === "ENOENT") return canonicalDirectory
  if (result.error?.code === "ETIMEDOUT") throw new Skip("Git root check timed out")
  if (result.error) throw new Skip("Git root check failed")

  if (result.status !== 0) {
    if (result.status === 128 && /not a git repository/i.test(result.stderr ?? "")) {
      return canonicalDirectory
    }
    throw new Skip("Git root check failed")
  }
  const output = result.stdout.trim()
  if (!isAbsolute(output)) throw new Skip("Git returned an invalid repository root")
  try {
    return realpathSync(output)
  } catch {
    throw new Skip("Git repository root cannot be resolved")
  }
}

function verifyViewerRoot(plan, pane) {
  const primaryRoot = rootForDirectory(pane.cwd)
  if (rootForDirectory(plan.projectDirectory) !== primaryRoot) throw new Skip("plan is outside the current viewer root")

  if (typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0) {
    if (!isAbsolute(pane.foreground_cwd) || rootForDirectory(pane.foreground_cwd) !== primaryRoot) {
      throw new Skip("foreground pane cwd does not match the viewer root")
    }
  }

  const pathFromRoot = relative(primaryRoot, plan.planPath)
  if (!pathFromRoot || isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Skip("plan is outside the current viewer root")
  }
}

function markerState(path) {
  try {
    const info = lstatSync(path)
    if (!info.isFile()) throw new Skip("invalid viewer marker in this workspace")
    return true
  } catch (error) {
    if (error instanceof Skip) throw error
    if (error?.code === "ENOENT") return false
    throw new Skip("cannot inspect this workspace's viewer marker")
  }
}

function openPlan(plan, paneId, retry) {
  const marker = join(plan.workspace, MARKER_NAME)
  const markerExists = markerState(marker)
  if (markerExists && !retry) {
    throw new Skip("viewer launch was already attempted; use --retry only after checking whether a viewer opened")
  }
  if (!markerExists) {
    let descriptor
    try {
      descriptor = openSync(marker, "wx", 0o600)
      writeFileSync(descriptor, `${plan.planPath}\n`)
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Skip("another invocation already reserved this workspace")
      }
      throw new Skip("cannot record this workspace's viewer invocation")
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  try {
    execFileSync(process.env.HERDR_BIN_PATH || "herdr", [
      "plugin", "pane", "open",
      "--plugin", PLUGIN_ID,
      "--entrypoint", ENTRYPOINT_ID,
      "--placement", "split",
      "--target-pane", paneId,
      "--direction", "right",
      "--no-focus",
      "--env", `HERDR_FILE_VIEWER_OPEN=${plan.planPath}`,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    const status = error?.code === "ETIMEDOUT" ? "timed out" : "failed"
    throw new Skip(`viewer launch ${status}`)
  }
}

function printUsage(stream = process.stdout) {
  stream.write(HELP)
}

function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    if (process.argv.includes("--diagnose")) {
      process.stderr.write(`${error.message}\n`)
      printUsage(process.stderr)
      process.exitCode = 2
    }
    return
  }
  if (options.help) {
    printUsage()
    return
  }

  const report = (reason, failed = true) => {
    if (!options.diagnose) return
    process.stdout.write(`show-workflow-plan: ${reason}\n`)
    if (failed) process.exitCode = 1
  }

  try {
    if (isOptedOut()) throw new Skip("disabled by HERDR_WORKFLOW_PLAN_VIEWER")
    if (process.env.HERDR_ENV !== "1") throw new Skip("HERDR_ENV must equal 1")
    if (!process.env.HERDR_PANE_ID) throw new Skip("HERDR_PANE_ID is missing")

    const plan = validatePlanPath(options.planPath)
    const { paneId, pane } = verifyHerdrEnvironment()
    verifyViewerRoot(plan, pane)

    const marker = join(plan.workspace, MARKER_NAME)
    if (options.diagnose) {
      if (markerState(marker)) {
        throw new Skip("viewer launch was already attempted; --retry may create another split, so confirm no viewer is open first")
      }
      process.stdout.write(`show-workflow-plan: ready to open ${plan.planPath}; no pane was opened\n`)
      return
    }
    openPlan(plan, paneId, options.retry)
  } catch (error) {
    report(error instanceof Error ? error.message : "unexpected error")
  }
}

main()
