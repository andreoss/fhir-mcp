import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect, run } from "./health.js"

const go = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const stateOf = (checks: ReadonlyArray<{ name: string; state: string }>, name: string) =>
  checks.find((check) => check.name === name)?.state

describe("health", () => {
  it("answers well for a store held in memory", async () => {
    const found = await go(inspect(undefined, {}))
    expect(found.status).toBe("ok")
    expect(stateOf(found.checks, "config")).toBe("accepted")
    expect(stateOf(found.checks, "store")).toBe("in-memory")
  })

  it("says plainly that the engine was not observed", async () => {
    const found = await go(inspect(undefined, {}))
    expect(stateOf(found.checks, "engine")).toBe("not-observed")
  })

  it("answers well for a store whose directory is there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tools-health-"))
    const found = await go(inspect(join(dir, "state.duckdb"), {}))
    expect(stateOf(found.checks, "store")).toBe("reachable")
    expect(found.status).toBe("ok")
  })

  it("answers badly for a store whose directory is not there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tools-health-"))
    const found = await go(inspect(join(dir, "absent", "state.duckdb"), {}))
    expect(stateOf(found.checks, "store")).toBe("unreachable")
    expect(found.status).toBe("failing")
  })

  it("answers badly when the configuration is refused", async () => {
    const found = await go(inspect(undefined, { FHIR_TRANSPORT: "carrier-pigeon" }))
    expect(found.status).toBe("failing")
    expect(stateOf(found.checks, "config")).toContain("FHIR_TRANSPORT")
  })

  it("reports through the command with a status an orchestrator can read", async () => {
    const good = await Effect.runPromiseExit(run([], {}))
    if (!Exit.isSuccess(good)) throw new Error("expected success")
    expect(good.value.status).toBe(0)
    expect(JSON.parse(good.value.lines[0] ?? "")).toMatchObject({ status: "ok" })
    const bad = await Effect.runPromiseExit(run([], { FHIR_TRANSPORT: "carrier-pigeon" }))
    if (!Exit.isSuccess(bad)) throw new Error("expected success")
    expect(bad.value.status).toBe(1)
  })

  it("refuses an option it does not know", async () => {
    const exit = await Effect.runPromiseExit(run(["--everything"], {}))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--everything")
  })
})
