import { describe, expect, it } from "vitest"
import { ArgsError } from "./args.js"
import { Refused } from "./guard.js"
import { Rejected, Unavailable } from "../core/outcome.js"
import { emit, explain, storePath } from "./result.js"

describe("result", () => {
  it("emits one json line with a zero status", () => {
    const outcome = emit({ action: "version", from: 0 })
    expect(outcome.status).toBe(0)
    expect(outcome.lines).toHaveLength(1)
    expect(JSON.parse(outcome.lines[0] ?? "")).toEqual({ action: "version", from: 0 })
  })

  it("explains a rejected argument list", () => {
    expect(explain(new ArgsError({ problems: ["--size: expected a number"] })))
      .toContain("arguments rejected")
  })

  it("explains a refusal", () => {
    expect(explain(new Refused({ action: "rebuild the index" })))
      .toBe("refusing to rebuild the index without --force")
  })

  it("explains a store failure in the words of the operation outcome", () => {
    expect(explain(new Unavailable({ dependency: "store" }))).toBe("store unavailable")
    expect(explain(new Rejected({ reason: "no such type" }))).toBe("no such type")
  })

  it("takes the store path from the option first", () => {
    expect(storePath("given.duckdb", { FHIR_STORE_PATH: "env.duckdb" })).toBe("given.duckdb")
  })

  it("falls back to the configured store path", () => {
    expect(storePath(undefined, { FHIR_STORE_PATH: "env.duckdb" })).toBe("env.duckdb")
  })

  it("falls back to a store held in memory", () => {
    expect(storePath(undefined, {})).toBe(":memory:")
    expect(storePath(undefined, { FHIR_STORE_PATH: "  " })).toBe(":memory:")
  })
})
