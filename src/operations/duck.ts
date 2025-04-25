import { Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import type { Version } from "../core/interactions.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { COMPARTMENT } from "./compartment.js"
import type { Slice } from "./page.js"
import type { Found, Reader, Window } from "./records.js"

const MOMENT = "'%Y-%m-%dT%H:%M:%S.%gZ'"

const FIELDS = `r.resource_type as type, r.logical_id as id, r.version_id as version_id,
  strftime(r.last_updated, ${MOMENT}) as last_updated, r.deleted as deleted, r.body as body`

const PATH = /^\$[A-Za-z0-9_.]+$/

interface Where {
  readonly sql: string
  readonly values: ReadonlyArray<unknown>
}

const rows = (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Failure> =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: (): Failure => new Unavailable({ dependency: "store" })
  })

const versionOf = (row: Record<string, unknown>): Version => ({
  type: String(row["type"]),
  id: String(row["id"]),
  versionId: Number(row["version_id"]),
  lastUpdated: String(row["last_updated"]),
  deleted: row["deleted"] === true,
  body: JSON.parse(String(row["body"])) as FhirResource
})

const membership = (patient: string, types: ReadonlyArray<string>): Where => {
  const parts: Array<string> = []
  const values: Array<unknown> = []
  for (const type of types) {
    if (type === "Patient") {
      parts.push(`(r.resource_type = ? and r.logical_id = ?)`)
      values.push(type, patient)
      continue
    }
    const path = COMPARTMENT[type]
    if (path === undefined || !PATH.test(path)) continue
    parts.push(`(r.resource_type = ? and json_extract_string(r.body, '${path}') in (?, ?))`)
    values.push(type, `Patient/${patient}`, patient)
  }
  return { sql: parts.length === 0 ? "false" : parts.join(" or "), values }
}

const bounded = (window: Window): Where => {
  const on = window.on
  const column =
    on !== undefined && PATH.test(on)
      ? `json_extract_string(r.body, '${on}')`
      : `strftime(r.last_updated, ${MOMENT})`
  const parts: Array<string> = []
  const values: Array<unknown> = []
  if (window.since !== undefined) {
    parts.push(`${column} >= ?`)
    values.push(window.since)
  }
  if (window.till !== undefined) {
    parts.push(`${column} <= ?`)
    values.push(window.till)
  }
  return { sql: parts.length === 0 ? "true" : parts.join(" and "), values }
}

export const recordsOn = (connection: DuckDBConnection): Reader => {
  const get = (type: string, id: string): Effect.Effect<Version | undefined, Failure> =>
    rows(
      connection,
      `select ${FIELDS} from resource r
       where r.resource_type = ? and r.logical_id = ? and r.is_current`,
      [type, id]
    ).pipe(Effect.map((found) => (found[0] === undefined ? undefined : versionOf(found[0]))))

  const compartment = (
    patient: string,
    types: ReadonlyArray<string>,
    window: Window,
    slice: Slice
  ): Effect.Effect<Found, Failure> =>
    Effect.gen(function* () {
      const who = membership(patient, types)
      const when = bounded(window)
      const where = `r.is_current and not r.deleted and (${who.sql}) and (${when.sql})`
      const values = [...who.values, ...when.values]
      const tallied = yield* rows(
        connection,
        `select count(*) as n from resource r where ${where}`,
        values
      )
      const found = yield* rows(
        connection,
        `select ${FIELDS} from resource r where ${where}
         order by r.resource_type, r.logical_id limit ? offset ?`,
        [...values, slice.limit, slice.offset]
      )
      return { total: Number(tallied[0]?.["n"] ?? 0), of: found.map(versionOf) }
    })

  const byIdentifier = (
    type: string,
    value: string
  ): Effect.Effect<ReadonlyArray<Version>, Failure> =>
    rows(
      connection,
      `select ${FIELDS} from resource r
       where r.resource_type = ? and r.is_current and not r.deleted
         and exists (select 1 from resource_index i
                     where i.surrogate_id = r.surrogate_id and i.resource_type = ?
                       and i.name = 'identifier' and i.value = ?)
       order by r.logical_id`,
      [type, type, value]
    ).pipe(Effect.map((found) => found.map(versionOf)))

  return { get, compartment, byIdentifier }
}
