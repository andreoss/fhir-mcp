import { Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import type { Version, VersionedStore } from "../core/interactions.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { seed } from "../params/model.js"
import { emit } from "../params/reindex.js"
import { walk } from "../store/definitions.js"
import { index } from "../store/query.js"
import type { IndexEntry } from "../store/query.js"

const DEFINED = seed()

const TABLES: ReadonlyArray<string> = [
  "index_token",
  "index_number",
  "index_date",
  "index_quantity",
  "index_reference"
]

export const entriesOf = (
  type: string,
  body: FhirResource
): ReadonlyArray<IndexEntry> =>
  DEFINED.filter((one) => one.type === type).flatMap((one) =>
    walk(body, one.path).flatMap((value) => {
      const found = emit(one, value)
      return found._tag === "Typed" ? [found.entry] : []
    })
  )

const rows = (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown>
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Failure> =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: (): Failure => new Unavailable({ dependency: "store" })
  })

const surrogateOf = (
  connection: DuckDBConnection,
  entry: Version
): Effect.Effect<bigint | undefined, Failure> =>
  rows(
    connection,
    `select surrogate_id from resource
     where resource_type = ? and logical_id = ? and version_id = ?`,
    [entry.type, entry.id, entry.versionId]
  ).pipe(
    Effect.map((found) => {
      const held = found[0]?.["surrogate_id"]
      return held === undefined ? undefined : BigInt(String(held))
    })
  )

const dropped = (
  connection: DuckDBConnection,
  type: string,
  id: string
): Effect.Effect<void, Failure> =>
  Effect.forEach(
    TABLES,
    (table) =>
      rows(
        connection,
        `delete from ${table} where surrogate_id in
           (select surrogate_id from resource
            where resource_type = ? and logical_id = ?)`,
        [type, id]
      ),
    { discard: true }
  )

export const typed = (
  connection: DuckDBConnection,
  inner: VersionedStore
): VersionedStore => ({
  ...inner,
  insertVersion: (entry) =>
    Effect.gen(function* () {
      yield* inner.insertVersion(entry)
      if (entry.deleted) return
      const entries = entriesOf(entry.type, entry.body)
      if (entries.length === 0) return
      const surrogate = yield* surrogateOf(connection, entry)
      if (surrogate === undefined) return
      yield* index(connection, surrogate, entry.type, entries)
    }),
  purge: (type, id) =>
    Effect.zipRight(dropped(connection, type, id), inner.purge(type, id))
})
