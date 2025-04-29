import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registryOf, run, scaffold, sources } from "./scaffold.js"

const go = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const scratch = () => mkdtemp(join(tmpdir(), "tools-scaffold-"))

const started = (argv: ReadonlyArray<string>) => Effect.runPromiseExit(run(argv, {}))

describe("sources", () => {
  it("writes a job beside its test", () => {
    const made = sources("reindex", "src/jobs")
    expect(made.map((file) => file.path)).toEqual([
      join("src/jobs", "reindex.ts"),
      join("src/jobs", "reindex.test.ts")
    ])
  })

  it("carries no comment into what it generates", () => {
    for (const file of sources("bulk-delete", "src/jobs")) {
      expect(file.body).not.toContain("//")
      expect(file.body).not.toContain("/*")
    }
  })

  it("gives the job a name, a typed input and a handler", () => {
    const body = sources("reindex", "src/jobs")[0]?.body ?? ""
    expect(body).toContain('export const NAME = "reindex"')
    expect(body).toContain("export const Input")
    expect(body).toContain("export const decode")
    expect(body).toContain("export const run")
  })

  it("points the test at the job beside it", () => {
    const body = sources("reindex", "src/jobs")[1]?.body ?? ""
    expect(body).toContain('from "./reindex.js"')
    expect(body).toContain("describe")
    expect(body).toContain("expect")
  })
})

describe("registry", () => {
  it("registers every job by its declared name", () => {
    const body = registryOf(["reindex", "bulk-delete"])
    expect(body).toContain('import * as bulkDelete from "./bulk-delete.js"')
    expect(body).toContain('import * as reindex from "./reindex.js"')
    expect(body).toContain("[bulkDelete.NAME]: bulkDelete")
    expect(body).toContain("export type JobName")
    expect(body.indexOf("bulk-delete.js")).toBeLessThan(body.indexOf("reindex.js"))
  })
})

describe("scaffold", () => {
  it("writes the job, its test and the registration", async () => {
    const dir = await scratch()
    const report = await go(scaffold("reindex", dir, false))
    expect(report.job).toBe("reindex")
    expect(report.written).toHaveLength(3)
    expect(await readFile(join(dir, "reindex.ts"), "utf8")).toContain("NAME")
    expect(await readFile(join(dir, "reindex.test.ts"), "utf8")).toContain("reindex")
    expect(await readFile(join(dir, "registry.ts"), "utf8")).toContain("[reindex.NAME]")
  })

  it("keeps every scaffolded job in the registration", async () => {
    const dir = await scratch()
    await go(scaffold("reindex", dir, false))
    await go(scaffold("bulk-delete", dir, false))
    const registry = await readFile(join(dir, "registry.ts"), "utf8")
    expect(registry).toContain("[reindex.NAME]")
    expect(registry).toContain("[bulkDelete.NAME]")
    expect(registry).not.toContain("registry.js")
    expect(registry).not.toContain("test.js")
  })

  it("refuses to overwrite a job that is already there", async () => {
    const dir = await scratch()
    await go(scaffold("reindex", dir, false))
    const exit = await Effect.runPromiseExit(scaffold("reindex", dir, false))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--force")
    expect(exit.cause.error.message).toContain("reindex.ts")
  })

  it("overwrites a job once forced", async () => {
    const dir = await scratch()
    await go(scaffold("reindex", dir, false))
    const report = await go(scaffold("reindex", dir, true))
    expect(report.written).toHaveLength(3)
  })

  it("refuses a name that is not a job name", async () => {
    const dir = await scratch()
    for (const name of ["Reindex", "re index", "", "-reindex", "reindex-"]) {
      const exit = await Effect.runPromiseExit(scaffold(name, dir, false))
      if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
      expect(exit.cause.error.message).toContain("--name")
    }
  })
})

describe("scaffold command", () => {
  it("scaffolds into the directory it was given", async () => {
    const dir = await scratch()
    const exit = await started(["--name", "reindex", "--dir", dir])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({
      action: "scaffold",
      job: "reindex"
    })
  })

  it("refuses a run with no name", async () => {
    const exit = await started(["--dir", "somewhere"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--name")
  })

  it("refuses an unknown option", async () => {
    const exit = await started(["--name", "reindex", "--everything"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--everything")
  })
})
