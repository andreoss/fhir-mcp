import { Effect } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

const unavailable = (): Failure => new Unavailable({ dependency: "store" })

export const connect = (
  path: string
): Effect.Effect<DuckDBConnection, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: unavailable
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  )

export const rows = (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Failure> =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: unavailable
  })

export const tableExists = (
  connection: DuckDBConnection,
  name: string
): Effect.Effect<boolean, Failure> =>
  rows(
    connection,
    `select count(*) as n from information_schema.tables where table_name = ?`,
    [name]
  ).pipe(Effect.map((found) => Number(found[0]?.["n"] ?? 0) > 0))

export const currentVersion = (
  connection: DuckDBConnection
): Effect.Effect<number, Failure> =>
  Effect.flatMap(tableExists(connection, "schema_version"), (there) =>
    there
      ? rows(connection, `select max(version) as version from schema_version`).pipe(
          Effect.map((found) => Number(found[0]?.["version"] ?? 0))
        )
      : Effect.succeed(0)
  )
