import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { LogLevel } from "../config/config.js"
import { Metrics } from "../obs/metrics.js"
import { observed, permits } from "./log.js"

const written = async (level: LogLevel, outcome: "success" | "failure") => {
  const lines: Array<string> = []
  const meter = Effect.flatMap(Metrics, (held) =>
    held.record("search", "Patient", outcome, 3)
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(meter, observed(level, (text) => { lines.push(text) }))
    )
  )
  return lines
}

describe("the declared log level", () => {
  it("admits what stands at or above it", () => {
    expect(permits("info", "info")).toBe(true)
    expect(permits("info", "error")).toBe(true)
    expect(permits("warn", "info")).toBe(false)
    expect(permits("debug", "debug")).toBe(true)
  })

  it("writes an ordinary event when the level admits it", async () => {
    const lines = await written("info", "success")
    expect(lines.join("")).toContain("search")
  })

  it("withholds that same event when the level does not", async () => {
    expect(await written("warn", "success")).toEqual([])
  })

  it("still writes what stands above the level it withheld", async () => {
    expect((await written("warn", "failure")).join("")).toContain("search")
  })

  it("carries a correlation on every event it writes", async () => {
    const lines = await written("debug", "success")
    expect(lines.join("")).toContain("correlation")
  })
})
