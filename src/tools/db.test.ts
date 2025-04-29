import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { connect, currentVersion, rows, tableExists } from "./db.js"

const withConnection = <A>(use: (connection: DuckDBConnection) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(connect(":memory:"), (connection) => Effect.promise(() => use(connection)))
    )
  )

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("db", () => {
  it("opens a connection and answers a query", () =>
    withConnection(async (connection) => {
      const found = await run(rows(connection, "select 1 as n"))
      expect(Number(found[0]?.["n"])).toBe(1)
    }))

  it("reports a missing table as absent", () =>
    withConnection(async (connection) => {
      expect(await run(tableExists(connection, "schema_version"))).toBe(false)
    }))

  it("reports version zero before any schema is applied", () =>
    withConnection(async (connection) => {
      expect(await run(currentVersion(connection))).toBe(0)
    }))

  it("reports the highest recorded version", () =>
    withConnection(async (connection) => {
      await run(
        rows(connection, "create table schema_version (version integer, applied_at timestamp)")
      )
      expect(await run(tableExists(connection, "schema_version"))).toBe(true)
      expect(await run(currentVersion(connection))).toBe(0)
      await run(rows(connection, "insert into schema_version values (1, current_timestamp)"))
      await run(rows(connection, "insert into schema_version values (2, current_timestamp)"))
      expect(await run(currentVersion(connection))).toBe(2)
    }))

  it("turns a broken statement into a store failure", () =>
    withConnection(async (connection) => {
      const exit = await Effect.runPromiseExit(rows(connection, "select from"))
      expect(Effect.runSync(Effect.succeed(exit._tag))).toBe("Failure")
    }))
})
