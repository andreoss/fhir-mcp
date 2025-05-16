import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

const RUNNER = join(ROOT, "node_modules", "vitest", "vitest.mjs")

const PROBE = "src/protocol/revision.test.ts"

interface Ran {
  readonly status: number
  readonly out: string
}

const run = async (args: ReadonlyArray<string>): Promise<Ran> => {
  const reports = await mkdtemp(join(tmpdir(), "fhir-suite-gate-"))
  const child = spawn(
    process.execPath,
    [
      RUNNER,
      "run",
      "--coverage",
      `--coverage.reportsDirectory=${reports}`,
      ...args
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  )
  let out = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    out += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    out += chunk
  })
  const status = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1))
  })
  await rm(reports, { recursive: true, force: true })
  return { status, out }
}

describe("the coverage gate", () => {
  it("fails the build when coverage is under the threshold", async () => {
    const ran = await run([PROBE])
    expect(ran.out).toContain("does not meet global threshold (85%)")
    for (const metric of ["lines", "functions", "statements", "branches"]) {
      expect(ran.out).toContain(`Coverage for ${metric}`)
    }
    expect(ran.status).toBe(1)
  }, 120000)

  it("passes the build when coverage meets the threshold", async () => {
    const ran = await run(["--coverage.include=src/protocol/revision.ts", PROBE])
    expect(ran.out).not.toContain("does not meet global threshold")
    expect(ran.status).toBe(0)
  }, 120000)
})
