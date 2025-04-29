import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parametersOf } from "../store/definitions.js"
import { connect } from "./db.js"
import { migrate } from "./migrate.js"
import { writeText } from "./io.js"
import { compare, generate, measure, run, summarize } from "./bench.js"
import type { Summary } from "./bench.js"

const go = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const scratch = () => mkdtemp(join(tmpdir(), "tools-bench-"))

const started = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  Effect.runPromiseExit(Effect.scoped(run(argv, env)))

const summary = (label: string, throughput: number, p50: number): Summary => ({
  label,
  shape: "patient",
  size: 10,
  operations: 20,
  errors: 0,
  elapsedMs: 100,
  throughput,
  latencyMs: { p50, p90: p50, p99: p50, max: p50 }
})

describe("generate", () => {
  it("makes as many resources as it was asked for", () => {
    expect(generate("patient", 5, 1)).toHaveLength(5)
  })

  it("makes the same data twice for the same seed", () => {
    expect(generate("mixed", 8, 7)).toEqual(generate("mixed", 8, 7))
  })

  it("makes different data for a different seed", () => {
    expect(generate("patient", 8, 7)).not.toEqual(generate("patient", 8, 8))
  })

  it("makes only resources the store carries", () => {
    for (const resource of generate("mixed", 12, 3)) {
      expect(parametersOf(resource.resourceType)).toBeDefined()
      expect(typeof resource.id).toBe("string")
    }
  })

  it("makes one shape when one shape is asked for", () => {
    const types = new Set(generate("observation", 6, 2).map((resource) => resource.resourceType))
    expect([...types]).toEqual(["Observation"])
  })

  it("makes both shapes when mixed", () => {
    const types = new Set(generate("mixed", 6, 2).map((resource) => resource.resourceType))
    expect(types.size).toBe(2)
  })
})

describe("summarize", () => {
  const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it("reports latency by rank", () => {
    const found = summarize({
      label: "a",
      shape: "patient",
      size: 5,
      samples,
      errors: 0,
      elapsedMs: 1000
    })
    expect(found.latencyMs).toEqual({ p50: 5, p90: 9, p99: 10, max: 10 })
  })

  it("reports throughput over the elapsed time", () => {
    const found = summarize({
      label: "a",
      shape: "patient",
      size: 5,
      samples,
      errors: 0,
      elapsedMs: 1000
    })
    expect(found.operations).toBe(10)
    expect(found.throughput).toBe(10)
  })

  it("keeps the keys of a report in one order", () => {
    const found = summarize({
      label: "a",
      shape: "patient",
      size: 5,
      samples,
      errors: 1,
      elapsedMs: 1000
    })
    expect(Object.keys(found)).toEqual([
      "label",
      "shape",
      "size",
      "operations",
      "errors",
      "elapsedMs",
      "throughput",
      "latencyMs"
    ])
    expect(found.errors).toBe(1)
  })

  it("reports nothing measured as zero rather than as infinity", () => {
    const found = summarize({
      label: "a",
      shape: "patient",
      size: 0,
      samples: [],
      errors: 0,
      elapsedMs: 0
    })
    expect(found.throughput).toBe(0)
    expect(found.latencyMs.p50).toBe(0)
  })
})

describe("compare", () => {
  it("lays the metrics out in one order", () => {
    const found = compare(summary("before", 100, 1), summary("after", 100, 1), 0.1)
    expect(found.rows.map((row) => row.metric)).toEqual([
      "throughput",
      "p50",
      "p90",
      "p99",
      "max"
    ])
    expect(found.regressed).toEqual([])
  })

  it("calls slower latency a regression", () => {
    const found = compare(summary("before", 100, 1), summary("after", 100, 2), 0.1)
    expect(found.regressed).toContain("p50")
    expect(found.rows[1]?.ratio).toBe(2)
  })

  it("calls lower throughput a regression", () => {
    const found = compare(summary("before", 100, 1), summary("after", 50, 1), 0.1)
    expect(found.regressed).toContain("throughput")
  })

  it("lets a change inside the tolerance pass", () => {
    const found = compare(summary("before", 100, 1), summary("after", 95, 1.05), 0.1)
    expect(found.regressed).toEqual([])
  })

  it("names both runs it compared", () => {
    const found = compare(summary("before", 100, 1), summary("after", 100, 1), 0.2)
    expect(found.before).toBe("before")
    expect(found.after).toBe("after")
    expect(found.tolerance).toBe(0.2)
  })
})

describe("measure", () => {
  it("runs a write and a read for every generated resource", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(":memory:")
          yield* migrate(connection, "latest", false)
          const found = yield* measure(connection, {
            label: "run",
            shape: "patient",
            size: 4,
            seed: 1
          })
          expect(found.operations).toBe(8)
          expect(found.errors).toBe(0)
          expect(found.size).toBe(4)
          expect(found.label).toBe("run")
          expect(found.latencyMs.max).toBeGreaterThanOrEqual(0)
        })
      )
    ))
})

describe("bench commands", () => {
  it("writes generated data as one resource per line", async () => {
    const dir = await scratch()
    const out = join(dir, "seed.ndjson")
    const exit = await started(["generate", "--shape", "patient", "--size", "3", "--out", out])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({ action: "generate", size: 3 })
    expect((await readFile(out, "utf8")).trim().split("\n")).toHaveLength(3)
  })

  it("runs a workload and reports it", async () => {
    const exit = await started(["run", "--size", "2", "--label", "first"])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({ label: "first", operations: 4 })
  })

  it("compares two recorded runs", async () => {
    const dir = await scratch()
    const before = join(dir, "before.json")
    const after = join(dir, "after.json")
    await go(writeText(before, JSON.stringify(summary("before", 100, 1))))
    await go(writeText(after, JSON.stringify(summary("after", 40, 4))))
    const exit = await started(["compare", "--before", before, "--after", after])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.status).toBe(1)
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({ action: "compare" })
  })

  it("ends well when the compared runs hold", async () => {
    const dir = await scratch()
    const before = join(dir, "before.json")
    const after = join(dir, "after.json")
    await go(writeText(before, JSON.stringify(summary("before", 100, 1))))
    await go(writeText(after, JSON.stringify(summary("after", 100, 1))))
    const exit = await started(["compare", "--before", before, "--after", after])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.status).toBe(0)
  })

  it("refuses a recorded run that is not a report", async () => {
    const dir = await scratch()
    const before = join(dir, "before.json")
    await go(writeText(before, JSON.stringify({ label: "before" })))
    const exit = await started(["compare", "--before", before, "--after", before])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain(before)
  })

  it("refuses a comparison with nothing to compare", async () => {
    const exit = await started(["compare"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--before")
  })

  it("refuses a generate with nowhere to write", async () => {
    const exit = await started(["generate", "--size", "2"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--out")
  })

  it("refuses a shape it cannot make", async () => {
    const exit = await started(["generate", "--shape", "cube", "--out", "x"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--shape")
  })
})
