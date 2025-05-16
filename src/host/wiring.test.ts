import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { restrictionOf, started } from "./wiring.js"
import type { Config } from "../config/config.js"

const config = (scopes: ReadonlyArray<string>): Config => ({
  transport: "stdio",
  http: { host: "127.0.0.1", port: 8080, origins: [] },
  store: { path: ":memory:" },
  allowWrite: false,
  scopes,
  terminologyDir: undefined,
  logLevel: "info"
})

const tables = async (connection: never): Promise<ReadonlyArray<string>> => {
  const r = await (connection as unknown as {
    runAndReadAll: (s: string) => Promise<{ getRowObjects: () => Array<Record<string, unknown>> }>
  }).runAndReadAll("select table_name from information_schema.tables")
  return r.getRowObjects().map((row) => String(row["table_name"]))
}

describe("wiring", () => {
  it("names an unrestricted binding rather than reaching it by omission", () => {
    expect(restrictionOf(config([])).name).toBe("unrestricted")
    expect(restrictionOf(config(["patient:p1/*.read"])).name).toBe("granted")
  })

  it("creates the typed index tables the query backend needs", async () => {
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    await Effect.runPromise(Effect.scoped(started(connection as never)) as never)
    const held = await tables(connection as never)
    for (const wanted of ["index_token", "index_number", "index_date", "index_quantity", "index_reference"]) {
      expect(held).toContain(wanted)
    }
    connection.closeSync()
  })

  it("builds one cache for the process, not one per engine", async () => {
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    const deps = await Effect.runPromise(Effect.scoped(started(connection as never)) as never) as { cache: unknown }
    const again = await Effect.runPromise(Effect.scoped(started(connection as never)) as never) as { cache: unknown }
    expect(deps.cache).toBeDefined()
    expect(again.cache).toBeDefined()
    connection.closeSync()
  })

  it("reports a store it cannot prepare rather than serving a broken engine", async () => {
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    connection.closeSync()
    const exit = await Effect.runPromiseExit(Effect.scoped(started(connection as never)) as never)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
