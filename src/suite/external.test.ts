import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSuite, loadSuite, unmet } from "./external.js"

const scratch = () => mkdtemp(join(tmpdir(), "fhir-suite-expect-"))

const verdicts = [
  { id: "interaction:read", met: true },
  { id: "interaction:create", met: false }
]

describe("expectations loaded from outside", () => {
  it("names the shipped list when nothing else is asked for", () => {
    expect(defaultSuite({})).toMatch(/expect[/\\]baseline\.json$/)
  })

  it("lets an environment point at another suite", () => {
    expect(defaultSuite({ FHIR_SUITE_EXPECTATIONS: "/other.json" })).toBe("/other.json")
  })

  it("reads the shipped list rather than holding one in code", async () => {
    const found = await Effect.runPromise(loadSuite(defaultSuite({})))
    expect(found.suite.length).toBeGreaterThan(0)
    expect(found.expect.map((one) => one.id)).toContain("interaction:read")
  })

  it("takes an expectation with no note", async () => {
    const dir = await scratch()
    const path = join(dir, "s.json")
    await writeFile(
      path,
      JSON.stringify({ suite: "s", version: "4.0.1", expect: [{ id: "a" }] }),
      "utf8"
    )
    const found = await Effect.runPromise(loadSuite(path))
    expect(found.expect[0]).toEqual({ id: "a", note: "" })
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a file that is not an expectation list", async () => {
    const dir = await scratch()
    const path = join(dir, "s.json")
    await writeFile(path, "{", "utf8")
    const exit = await Effect.runPromiseExit(loadSuite(path))
    expect(exit._tag).toBe("Failure")
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a list whose entries are not expectations", async () => {
    const dir = await scratch()
    const path = join(dir, "s.json")
    await writeFile(path, JSON.stringify({ suite: "s", expect: 3 }), "utf8")
    const exit = await Effect.runPromiseExit(loadSuite(path))
    expect(exit._tag).toBe("Failure")
    await rm(dir, { recursive: true, force: true })
  })

  it("reports an expectation the run does not meet", () => {
    const suite = {
      suite: "s",
      version: "4.0.1",
      expect: [{ id: "interaction:read", note: "" }, { id: "interaction:create", note: "" }]
    }
    expect(unmet(suite, verdicts)).toEqual(["interaction:create"])
  })

  it("reports an expectation the run never checked at all", () => {
    const suite = {
      suite: "s",
      version: "4.0.1",
      expect: [{ id: "system:transaction", note: "" }]
    }
    expect(unmet(suite, verdicts)).toEqual(["system:transaction"])
  })

  it("reports nothing when every expectation is met", () => {
    const suite = {
      suite: "s",
      version: "4.0.1",
      expect: [{ id: "interaction:read", note: "" }]
    }
    expect(unmet(suite, verdicts)).toEqual([])
  })
})
