import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCHEMA_VERSION } from "../store/store.js"
import { connect, currentVersion, rows } from "./db.js"
import { STEPS, migrate, run } from "./migrate.js"

const withConnection = <A>(use: (connection: DuckDBConnection) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(connect(":memory:"), (connection) => Effect.promise(() => use(connection)))
    )
  )

const go = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const started = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  Effect.runPromiseExit(Effect.scoped(run(argv, env)))

describe("migrate", () => {
  it("declares its steps in ascending order", () => {
    expect(STEPS.length).toBeGreaterThan(0)
    const versions = STEPS.map((step) => step.version)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
    expect(versions[versions.length - 1]).toBe(SCHEMA_VERSION)
  })

  it("reports version zero for a store with no schema", () =>
    withConnection(async (connection) => {
      const report = await go(migrate(connection, "version", false))
      expect(report).toEqual({ action: "version", from: 0, to: 0, applied: [], forced: false })
    }))

  it("applies every step to reach the latest version", () =>
    withConnection(async (connection) => {
      const report = await go(migrate(connection, "latest", false))
      expect(report.from).toBe(0)
      expect(report.to).toBe(SCHEMA_VERSION)
      expect(report.applied).toEqual(STEPS.map((step) => step.version))
    }))

  it("applies one step at a time", () =>
    withConnection(async (connection) => {
      const report = await go(migrate(connection, "next", false))
      expect(report.applied).toEqual([STEPS[0]?.version])
      expect(report.to).toBe(STEPS[0]?.version)
    }))

  it("applies nothing when the store is already current", () =>
    withConnection(async (connection) => {
      await go(migrate(connection, "latest", false))
      const again = await go(migrate(connection, "latest", false))
      expect(again.applied).toEqual([])
      expect(again.from).toBe(SCHEMA_VERSION)
      expect(again.to).toBe(SCHEMA_VERSION)
    }))

  it("re-applies recorded steps only when forced", () =>
    withConnection(async (connection) => {
      await go(migrate(connection, "latest", false))
      const forced = await go(migrate(connection, "latest", true))
      expect(forced.forced).toBe(true)
      expect(forced.applied).toEqual(STEPS.map((step) => step.version))
      expect(forced.to).toBe(SCHEMA_VERSION)
    }))

  it("leaves the recorded version alone when only reporting", () =>
    withConnection(async (connection) => {
      await go(migrate(connection, "latest", false))
      await go(migrate(connection, "version", false))
      expect(await go(currentVersion(connection))).toBe(SCHEMA_VERSION)
    }))

  it("builds the tables both stores need", () =>
    withConnection(async (connection) => {
      await go(migrate(connection, "latest", false))
      const found = await go(
        rows(connection, "select table_name from information_schema.tables order by table_name")
      )
      const names = found.map((row) => String(row["table_name"]))
      expect(names).toContain("resource")
      expect(names).toContain("resource_index")
      expect(names).toContain("schema_version")
    }))

  it("answers a run with one json line and a zero status", async () => {
    const exit = await started(["latest"])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.status).toBe(0)
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({
      action: "latest",
      to: SCHEMA_VERSION
    })
  })

  it("migrates the store named by the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tools-migrate-"))
    const path = join(dir, "state.duckdb")
    const exit = await started(["latest"], { FHIR_STORE_PATH: path })
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    const second = await started(["version"], { FHIR_STORE_PATH: path })
    if (!Exit.isSuccess(second)) throw new Error("expected success")
    expect(JSON.parse(second.value.lines[0] ?? "")).toMatchObject({ from: SCHEMA_VERSION })
  })

  it("refuses a run with no verb", async () => {
    const exit = await started([])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("latest")
  })

  it("refuses an option it does not know", async () => {
    const exit = await started(["latest", "--everything"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--everything")
  })
})
