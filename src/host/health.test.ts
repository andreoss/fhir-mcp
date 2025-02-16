import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { Engine } from "../core/engine.js"
import { Rejected, Unavailable, statusOf } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { engineOn } from "../store/store.js"
import {
  BOUNDS,
  assured,
  live,
  readiness,
  storeProbe
} from "./health.js"
import type { Bounds, Probe, Reading } from "./health.js"

const bounds: Bounds = { budget: 60, retryAfter: 7 }
const patient: Bounds = { budget: 15000, retryAfter: 7 }

const up = (name: string): Probe => ({ name, check: Effect.succeed(1) })

const failing = (name: string, error: Failure): Probe => ({
  name,
  check: Effect.fail(error)
})

const stalled = (name: string): Probe => ({ name, check: Effect.never })

const dying = (name: string): Probe => ({
  name,
  check: Effect.die(new Error("engine lost at 10.0.0.4:5432"))
})

const reading = (
  checks: ReadonlyArray<Reading>,
  name: string
): Reading => {
  const found = checks.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`no reading for ${name}`)
  return found
}

const brokenEngine = (): Engine & { readonly closed: boolean } => ({
  closed: false,
  read: () => Effect.fail(new Unavailable({ dependency: "store" })),
  search: () => Effect.fail(new Unavailable({ dependency: "store" })),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["_id"])
})

const openStore = async () => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const store = await Effect.runPromise(engineOn(connection))
  return { connection, store }
}

describe("health", () => {
  it("reports every dependency it needs by name", async () => {
    const report = await Effect.runPromise(
      readiness([up("store"), up("terminology")], bounds)
    )
    expect(report.checks.map((entry) => entry.name)).toEqual([
      "store",
      "terminology"
    ])
    expect(report.status).toBe("ready")
  })

  it("answers ready with no retry hint when every check is up", async () => {
    const report = await Effect.runPromise(readiness([up("store")], bounds))
    expect(report.status).toBe("ready")
    expect(report.retryAfter).toBeUndefined()
  })

  it("calls a dependency unhealthy when it takes a handle but fails a query", async () => {
    const engine = brokenEngine()
    const report = await Effect.runPromise(
      readiness([storeProbe(engine)], bounds)
    )
    expect(engine.closed).toBe(false)
    expect(Effect.runSync(engine.resourceTypes())).toHaveLength(1)
    expect(reading(report.checks, "store").state).toBe("down")
    expect(report.status).toBe("unready")
  })

  it("catches a real store whose connection stopped answering queries", async () => {
    const { connection, store } = await openStore()
    const well = await Effect.runPromise(
      readiness([storeProbe(store)], patient)
    )
    expect(reading(well.checks, "store").state).toBe("up")
    connection.closeSync()
    const unwell = await Effect.runPromise(
      readiness([storeProbe(store)], patient)
    )
    expect(reading(unwell.checks, "store").state).toBe("down")
    expect(unwell.status).toBe("unready")
  })

  it("exercises the store with a real query rather than reading a flag", async () => {
    const asked: Array<string> = []
    const engine: Engine = {
      read: () => Effect.fail(new Unavailable({ dependency: "store" })),
      search: (query) => {
        asked.push(query.type)
        return Effect.succeed({ resourceType: "Bundle", type: "searchset", total: 0 })
      },
      resourceTypes: () => Effect.succeed(["Patient"]),
      searchParameters: () => Effect.succeed([])
    }
    const report = await Effect.runPromise(
      readiness([storeProbe(engine, "Observation")], bounds)
    )
    expect(asked).toEqual(["Observation"])
    expect(reading(report.checks, "store").state).toBe("up")
  })

  it("reports a dependency that never answers as timed out, never as up", async () => {
    const report = await Effect.runPromise(
      readiness([stalled("engine")], bounds)
    )
    expect(reading(report.checks, "engine").state).toBe("timeout")
    expect(report.status).toBe("unready")
  })

  it("bounds one slow check instead of hanging the whole report", async () => {
    const started = Date.now()
    const report = await Effect.runPromise(
      readiness([stalled("engine"), up("store")], bounds)
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(reading(report.checks, "store").state).toBe("up")
    expect(reading(report.checks, "engine").state).toBe("timeout")
    expect(reading(report.checks, "engine").millis).toBeLessThan(2_000)
  })

  it("says when to retry once a dependency is unwell", async () => {
    const report = await Effect.runPromise(
      readiness([failing("store", new Unavailable({ dependency: "store" }))], bounds)
    )
    expect(report.retryAfter).toBe(7)
  })

  it("keeps answering when a check throws instead of failing", async () => {
    const report = await Effect.runPromise(readiness([dying("store")], bounds))
    expect(reading(report.checks, "store").state).toBe("down")
    expect(report.status).toBe("unready")
  })

  it("holds a default budget and retry hint", async () => {
    expect(BOUNDS.budget).toBeGreaterThan(0)
    expect(BOUNDS.retryAfter).toBeGreaterThan(0)
    const report = await Effect.runPromise(readiness([up("store")]))
    expect(report.status).toBe("ready")
  })

  it("separates being alive from being able to serve", async () => {
    const report = await Effect.runPromise(readiness([stalled("store")], bounds))
    expect(live().status).toBe("live")
    expect(report.status).toBe("unready")
  })

  it("is ready when it needs nothing", async () => {
    const report = await Effect.runPromise(readiness([], bounds))
    expect(report.status).toBe("ready")
    expect(report.checks).toEqual([])
  })

  it("names the dependency without the query, the address or the stack", async () => {
    const leaky = failing(
      "store",
      new Rejected({ reason: "select body from resource at 10.0.0.4:5432" })
    )
    const report = await Effect.runPromise(
      readiness([leaky, dying("terminology")], bounds)
    )
    const text = JSON.stringify(report)
    expect(text).toContain("store")
    expect(text).not.toContain("select")
    expect(text).not.toContain("10.0.0.4")
    expect(text).not.toContain("Error")
    expect(text).not.toContain("resource")
  })

  it("turns an unready report into an unavailable failure for the caller", async () => {
    const report = await Effect.runPromise(
      readiness([up("terminology"), stalled("store")], bounds)
    )
    const exit = await Effect.runPromiseExit(assured(report))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") {
      throw new Error("expected a failure")
    }
    expect(exit.cause.error._tag).toBe("Unavailable")
    expect(statusOf(exit.cause.error)).toBe(503)
    expect(JSON.stringify(exit.cause.error)).toContain("store")
  })

  it("passes a ready report through untouched", async () => {
    const report = await Effect.runPromise(readiness([up("store")], bounds))
    expect(await Effect.runPromise(assured(report))).toBe(report)
  })
})
