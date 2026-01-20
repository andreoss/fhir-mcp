import { Effect } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Criteria, Version } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf } from "../store/definitions.js"
import { plan } from "../store/versioned.js"
import type { Incumbent, Schema, SearchState } from "./incumbent.js"

const MOMENT = "'%Y-%m-%dT%H:%M:%S.%gZ'"

const FIELDS = `resource_type as type, logical_id as id, version_id,
  strftime(last_updated, ${MOMENT}) as last_updated, deleted, body`

const refused = (): Failure => new Unavailable({ dependency: "incumbent" })

const ask = (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: refused
  })

const versionOf = (row: Record<string, unknown>): Version => ({
  type: String(row["type"]),
  id: String(row["id"]),
  versionId: Number(row["version_id"]),
  lastUpdated: String(row["last_updated"]),
  deleted: row["deleted"] === true,
  body: JSON.parse(String(row["body"])) as FhirResource
})

export const incumbentOn = (connection: DuckDBConnection): Incumbent => {
  const held: Incumbent = {
    schema: () =>
      Effect.all({
        version: Effect.match(
          ask(connection, `select max(version) as version from schema_version`),
          { onFailure: () => 0, onSuccess: (found) => Number(found[0]?.["version"] ?? 0) }
        ),
        column: ask(connection, `select table_name, column_name, data_type
           from information_schema.columns
           order by table_name, ordinal_position`)
      }).pipe(
        Effect.map(({ version, column }): Schema => {
          const named = new Map<string, Array<{ name: string; type: string }>>()
          for (const row of column) {
            const table = String(row["table_name"])
            const entry = { name: String(row["column_name"]), type: String(row["data_type"]) }
            const gathered = named.get(table)
            if (gathered === undefined) named.set(table, [entry])
            else gathered.push(entry)
          }
          return {
            version,
            table: [...named].map(([name, column]) => ({ name, column }))
          }
        })
      ),
    types: () =>
      Effect.map(
        ask(connection, `select distinct resource_type as type from resource order by 1`),
        (found) => found.map((row) => String(row["type"]))
      ),
    records: (type) =>
      Effect.map(
        ask(
          connection,
          `select ${FIELDS} from resource where resource_type = ?
           order by logical_id, version_id`,
          [type]
        ),
        (found) => found.map(versionOf)
      ),
    searchState: () =>
      Effect.map(
        ask(connection, `select resource_type as type, name, count(*) as indexed
           from resource_index group by resource_type, name order by 1, 2`),
        (found) =>
          found.map((row): SearchState => ({
            type: String(row["type"]),
            name: String(row["name"]),
            ready: true,
            indexed: Number(row["indexed"])
          }))
      ),
    read: (type, id) =>
      Effect.map(
        ask(
          connection,
          `select ${FIELDS} from resource
           where resource_type = ? and logical_id = ? and is_current`,
          [type, id]
        ),
        (found) => (found[0] === undefined ? undefined : versionOf(found[0]))
      ),
    matching: (type: string, criteria: Criteria) => {
      const definitions = parametersOf(type)
      if (definitions === undefined) {
        return Effect.fail(new Unavailable({ dependency: "index" }))
      }
      const unknown = criteria
        .map(([name]) => name)
        .filter((name) => definitions[name] === undefined)
      if (unknown.length > 0) {
        return Effect.fail(
          new Rejected({ reason: `unsupported criterion: ${unknown.join(", ")}` })
        )
      }
      const prepared = plan(type, criteria)
      return Effect.map(
        ask(
          connection,
          `select ${FIELDS} from resource r where ${prepared.where}`,
          prepared.values
        ),
        (found) => found.map(versionOf)
      )
    }
  }
  return held
}

export const open = (path: string): Effect.Effect<Incumbent, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: refused
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(Effect.map(incumbentOn))
