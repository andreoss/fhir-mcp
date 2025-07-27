import { spawn } from "node:child_process"
import { mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export interface Building {
  readonly entry: string
  readonly compile?: () => Promise<void>
  readonly lock?: string
  readonly budget?: number
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

const WAIT = 90000

const PAUSE = 100

export const defaultEntry = (
  env: Record<string, string | undefined> = process.env
): string => env["FHIR_SUITE_ENTRY"] ?? join(ROOT, "dist", "host", "cli.js")

export const termsEntry = (
  env: Record<string, string | undefined> = process.env
): string => env["FHIR_SUITE_TERMS_ENTRY"] ?? join(ROOT, "dist", "suite", "cli.js")

const there = (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false)

const later = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc")

export const compiler = (bin: string, cwd: string): (() => Promise<void>) => () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "-p", "tsconfig.build.json"], {
      cwd,
      stdio: "ignore"
    })
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build refused: ${String(code)}`))
    )
  })

export const ensure = async (asked: Building): Promise<string> => {
  const entry = asked.entry
  if (await there(entry)) return entry
  const lock = asked.lock ?? join(tmpdir(), "fhir-suite-build.lock")
  const budget = asked.budget ?? WAIT
  const compile = asked.compile ?? compiler(TSC, ROOT)
  const mine = await mkdir(lock).then(() => true, () => false)
  if (mine) {
    try {
      await compile()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
    return entry
  }
  const until = Date.now() + budget
  while (Date.now() < until) {
    await later(PAUSE)
    if (await there(entry)) return entry
  }
  throw new Error(`build not found: ${entry}`)
}
