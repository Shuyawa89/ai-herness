import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export function createSessionWorkspace(projectDirectory, description, now = new Date()) {
  if (typeof description !== "string" || description.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(description)) {
    throw new Error("The task description must be 1–64 lowercase letters, digits, or single separating hyphens.")
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("A valid timestamp is required.")
  }

  const project = realpathSync(projectDirectory)
  const temporaryRoot = ensureProjectDirectory(resolve(project, ".temp-local"), project, "temporary directory")
  const root = ensureProjectDirectory(resolve(temporaryRoot, "sessions"), project, "session workspace root")
  const pad = (number) => String(number).padStart(2, "0")
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const name = `${timestamp}-${description}`

  for (let suffix = 1; ; suffix += 1) {
    const directory = resolve(root, suffix === 1 ? name : `${name}-${suffix}`)
    try {
      // mkdir reserves the name atomically, including across independent processes.
      mkdirSync(directory, { mode: 0o700 })
      return realpathSync(directory)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
  }
}

function ensureProjectDirectory(directory, project, label) {
  let canonical = canonicalProjectDirectory(directory, project, label)
  if (canonical) return canonical

  try {
    // Create one level only after its parent has already been canonicalized and checked.
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }

  canonical = canonicalProjectDirectory(directory, project, label)
  if (!canonical) throw new Error(`The ${label} could not be created.`)
  return canonical
}

function canonicalProjectDirectory(directory, project, label) {
  let entry
  try {
    entry = lstatSync(directory)
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`The ${label} must not be a symbolic link; it must remain inside this project.`)
  }

  let canonical
  try {
    canonical = realpathSync(directory)
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }

  if (!statSync(canonical).isDirectory()) {
    throw new Error(`The ${label} must be a directory.`)
  }
  const pathRelative = relative(project, canonical)
  if (!pathRelative || isAbsolute(pathRelative) || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) {
    throw new Error(`The ${label} must remain inside this project.`)
  }
  return canonical
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) {
      throw new Error("Usage: node session-workspace.mjs <project-directory> <short-task-description>")
    }
    process.stdout.write(`${createSessionWorkspace(process.argv[2], process.argv[3])}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
