import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { load, pathOf, regressions, save } from "./record.js"
import type { Conformance } from "./record.js"

const scratch = () => mkdtemp(join(tmpdir(), "fhir-suite-record-"))

const sheet = (
  checks: ReadonlyArray<{ id: string; met: boolean }>,
  unmet: ReadonlyArray<string> = []
): Conformance => ({
  revision: "2025-03-26",
  fhirVersion: "4.0.1",
  software: { name: "fhir-mcp", version: "0.0.0" },
  checks,
  unmet
})

describe("the recorded conformance of a version", () => {
  it("names the file after the version it records", () => {
    expect(pathOf("/rec", "4.0.1")).toBe(join("/rec", "conformance-4.0.1.json"))
  })

  it("reports no record when a version was never run", async () => {
    const dir = await scratch()
    const found = await Effect.runPromise(load(pathOf(dir, "4.0.1")))
    expect(found).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it("reads back what it wrote, checks ordered", async () => {
    const dir = await scratch()
    const path = pathOf(dir, "4.0.1")
    const written = sheet([{ id: "type:Patient", met: true }, { id: "b", met: false }])
    await Effect.runPromise(save(path, written))
    const found = await Effect.runPromise(load(path))
    expect(found?.checks.map((one) => one.id)).toEqual(["b", "type:Patient"])
    expect(found?.fhirVersion).toBe("4.0.1")
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a record that is not one", async () => {
    const dir = await scratch()
    const path = pathOf(dir, "4.0.1")
    await writeFile(path, "not a record", "utf8")
    const exit = await Effect.runPromiseExit(load(path))
    expect(exit._tag).toBe("Failure")
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a record whose shape moved on", async () => {
    const dir = await scratch()
    const path = pathOf(dir, "4.0.1")
    await writeFile(path, JSON.stringify({ revision: 3 }), "utf8")
    const exit = await Effect.runPromiseExit(load(path))
    expect(exit._tag).toBe("Failure")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("regression between two runs", () => {
  it("finds none on a first run", () => {
    expect(regressions(undefined, sheet([{ id: "a", met: true }]))).toEqual([])
  })

  it("finds none when the same checks are met again", () => {
    const before = sheet([{ id: "a", met: true }, { id: "b", met: false }])
    expect(regressions(before, before)).toEqual([])
  })

  it("names a check that was met and is not", () => {
    const before = sheet([{ id: "a", met: true }, { id: "b", met: true }])
    const after = sheet([{ id: "a", met: true }, { id: "b", met: false }])
    expect(regressions(before, after)).toEqual(["b"])
  })

  it("names a check that was met and has gone", () => {
    const before = sheet([{ id: "a", met: true }, { id: "b", met: true }])
    expect(regressions(before, sheet([{ id: "a", met: true }]))).toEqual(["b"])
  })

  it("welcomes a check that was failing and now passes", () => {
    const before = sheet([{ id: "a", met: false }])
    expect(regressions(before, sheet([{ id: "a", met: true }]))).toEqual([])
  })

  it("names an external expectation that has become unmet", () => {
    const before = sheet([{ id: "a", met: true }], ["x"])
    const after = sheet([{ id: "a", met: true }], ["x", "y"])
    expect(regressions(before, after)).toEqual(["y"])
  })

  it("names each regressed id once and in order", () => {
    const before = sheet([{ id: "b", met: true }, { id: "a", met: true }], [])
    const after = sheet([{ id: "b", met: false }, { id: "a", met: false }], ["a", "b"])
    expect(regressions(before, after)).toEqual(["a", "b"])
  })
})
