import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, Engine, FhirResource, SearchQuery } from "../core/engine.js"
import { Gone, NotFound, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf, types, walk } from "./definitions.js"

export const SCHEMA_VERSION = 1

const STATEMENTS: ReadonlyArray<string> = [
  `create table if not exists schema_version (
     version integer not null primary key,
     applied_at timestamp not null
   )`,
  `create sequence if not exists surrogate_id start 1`,
  `create table if not exists resource (
     surrogate_id bigint primary key,
     resource_type varchar not null,
     logical_id varchar not null,
     version_id integer not null,
     last_updated timestamp not null,
     deleted boolean not null,
     is_current boolean not null,
     body varchar not null
   )`,
  `create table if not exists resource_index (
     surrogate_id bigint not null,
     resource_type varchar not null,
     name varchar not null,
     value varchar not null
   )`,
  `create index if not exists resource_current on resource (resource_type, logical_id, is_current)`,
  `create index if not exists resource_index_lookup on resource_index (resource_type, name, value)`
]

export interface Store extends Engine {
  readonly migrate: () => Effect.Effect<void, Failure>
  readonly schemaVersion: () => Effect.Effect<number, Failure>
  readonly put: (resource: FhirResource) => Effect.Effect<FhirResource, Failure>
  readonly remove: (type: string, id: string) => Effect.Effect<void, Failure>
  readonly versions: (type: string, id: string) => Effect.Effect<number, Failure>
}

const asFailure = (): Failure => new Unavailable({ dependency: "store" })

const query = (connection: DuckDBConnection, sql: string, values: ReadonlyArray<unknown> = []) =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: asFailure
  })

const nowIso = () => new Date().toISOString()

const rowsOf = (resource: FhirResource, surrogate: bigint) => {
  const definitions = parametersOf(resource.resourceType)
  if (definitions === undefined) return []
  return Object.entries(definitions).flatMap(([name, definition]) =>
    walk(resource, definition.path).map((value) => ({ surrogate, name, value }))
  )
}

const stamped = (resource: FhirResource, versionId: number, lastUpdated: string): FhirResource => ({
  ...resource,
  meta: {
    ...(typeof resource["meta"] === "object" && resource["meta"] !== null
      ? (resource["meta"] as Record<string, unknown>)
      : {}),
    versionId: String(versionId),
    lastUpdated
  }
})

const make = (connection: DuckDBConnection): Store => {
  const migrate = () =>
    Effect.gen(function* () {
      for (const statement of STATEMENTS) {
        yield* query(connection, statement)
      }
      yield* query(
        connection,
        `insert into schema_version (version, applied_at)
         select ?, current_timestamp
         where not exists (select 1 from schema_version where version = ?)`,
        [SCHEMA_VERSION, SCHEMA_VERSION]
      )
    })

  const schemaVersion = () =>
    query(connection, `select max(version) as version from schema_version`).pipe(
      Effect.map((rows) => Number(rows[0]?.["version"] ?? 0))
    )

  const currentRow = (type: string, id: string) =>
    query(
      connection,
      `select surrogate_id, version_id, deleted, body
       from resource
       where resource_type = ? and logical_id = ? and is_current`,
      [type, id]
    ).pipe(Effect.map((rows) => rows[0]))

  const known = (type: string) =>
    parametersOf(type) === undefined
      ? Effect.fail(new Rejected({ reason: `unsupported resource type: ${type}` }))
      : Effect.void

  const read = (type: string, id: string) =>
    Effect.gen(function* () {
      yield* known(type)
      const row = yield* currentRow(type, id)
      if (row === undefined) return yield* Effect.fail(new NotFound({ type, id }))
      if (row["deleted"] === true) return yield* Effect.fail(new Gone({ type, id }))
      return JSON.parse(String(row["body"])) as FhirResource
    })

  const versions = (type: string, id: string) =>
    query(
      connection,
      `select count(*) as count from resource where resource_type = ? and logical_id = ?`,
      [type, id]
    ).pipe(Effect.map((rows) => Number(rows[0]?.["count"] ?? 0)))

  const put = (resource: FhirResource) =>
    Effect.gen(function* () {
      yield* known(resource.resourceType)
      const id = resource.id
      if (typeof id !== "string" || id.length === 0) {
        return yield* Effect.fail(new Rejected({ reason: "resource carries no id" }))
      }
      const existing = yield* currentRow(resource.resourceType, id)
      const versionId = existing === undefined ? 1 : Number(existing["version_id"]) + 1
      const lastUpdated = nowIso()
      const written = stamped(resource, versionId, lastUpdated)
      yield* query(
        connection,
        `update resource set is_current = false
         where resource_type = ? and logical_id = ? and is_current`,
        [resource.resourceType, id]
      )
      const inserted = yield* query(
        connection,
        `insert into resource
           (surrogate_id, resource_type, logical_id, version_id, last_updated, deleted, is_current, body)
         values (nextval('surrogate_id'), ?, ?, ?, ?, false, true, ?)
         returning surrogate_id`,
        [resource.resourceType, id, versionId, lastUpdated, JSON.stringify(written)]
      )
      const surrogate = BigInt(String(inserted[0]?.["surrogate_id"] ?? 0))
      for (const row of rowsOf(written, surrogate)) {
        yield* query(
          connection,
          `insert into resource_index (surrogate_id, resource_type, name, value)
           values (?, ?, ?, ?)`,
          [row.surrogate, written.resourceType, row.name, row.value]
        )
      }
      return written
    })

  const remove = (type: string, id: string) =>
    Effect.gen(function* () {
      yield* known(type)
      const existing = yield* currentRow(type, id)
      if (existing === undefined) return yield* Effect.fail(new NotFound({ type, id }))
      if (existing["deleted"] === true) return
      const versionId = Number(existing["version_id"]) + 1
      yield* query(
        connection,
        `update resource set is_current = false where resource_type = ? and logical_id = ? and is_current`,
        [type, id]
      )
      yield* query(
        connection,
        `insert into resource
           (surrogate_id, resource_type, logical_id, version_id, last_updated, deleted, is_current, body)
         values (nextval('surrogate_id'), ?, ?, ?, ?, true, true, ?)`,
        [type, id, versionId, nowIso(), JSON.stringify({ resourceType: type, id })]
      )
    })

  const search = (request: SearchQuery) =>
    Effect.gen(function* () {
      const definitions = parametersOf(request.type)
      if (definitions === undefined) {
        return yield* Effect.fail(new Rejected({ reason: `unsupported resource type: ${request.type}` }))
      }
      const unsupported = request.parameters
        .map(([name]) => name)
        .filter((name) => definitions[name] === undefined)
      if (unsupported.length > 0) {
        return yield* Effect.fail(
          new Rejected({ reason: `unsupported search parameter: ${unsupported.join(", ")}` })
        )
      }
      const values: Array<unknown> = [request.type]
      const clauses = request.parameters.map(([name, value]) => {
        values.push(request.type, name, value)
        return `exists (
          select 1 from resource_index i
          where i.surrogate_id = r.surrogate_id
            and i.resource_type = ? and i.name = ? and i.value = ?
        )`
      })
      const where = ["r.resource_type = ?", "r.is_current", "not r.deleted", ...clauses].join(" and ")
      const rows = yield* query(
        connection,
        `select r.body from resource r where ${where} order by r.surrogate_id`,
        values
      )
      const entry = rows.map((row) => ({ resource: JSON.parse(String(row["body"])) as FhirResource }))
      return { resourceType: "Bundle", type: "searchset", total: entry.length, entry } satisfies Bundle
    })

  const resourceTypes = () => Effect.succeed(types())

  const searchParameters = (type: string) =>
    Effect.gen(function* () {
      yield* known(type)
      return Object.keys(parametersOf(type) ?? {})
    })

  return { migrate, schemaVersion, read, put, remove, search, versions, resourceTypes, searchParameters }
}

export const open = (path: string): Effect.Effect<Store, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: asFailure
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(
    Effect.flatMap((connection) => {
      const store = make(connection)
      return Effect.as(store.migrate(), store)
    })
  )

export const layer = (path: string): Layer.Layer<FhirEngine, Failure> =>
  Layer.scoped(FhirEngine, open(path))
