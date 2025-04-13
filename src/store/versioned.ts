import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Versions } from "../core/interactions.js"
import type { Criteria, Version, VersionedStore } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { Conflict, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf, walk } from "./definitions.js"

const STATEMENTS: ReadonlyArray<string> = [
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
  `create index if not exists resource_current
     on resource (resource_type, logical_id, is_current)`,
  `create index if not exists resource_index_lookup
     on resource_index (resource_type, name, value)`,
  `create unique index if not exists resource_version
     on resource (resource_type, logical_id, version_id)`
]

const MOMENT = "'%Y-%m-%dT%H:%M:%S.%gZ'"

const FIELDS = `resource_type as type, logical_id as id, version_id,
  strftime(last_updated, ${MOMENT}) as last_updated, deleted, body`

export interface Plan {
  readonly where: string
  readonly values: ReadonlyArray<unknown>
}

export interface Versioned extends VersionedStore {
  readonly currents: (type: string, id: string) => Effect.Effect<number, Failure>
  readonly tally: (type: string, criteria: Criteria) => Effect.Effect<number, Failure>
}

interface Wired extends Versioned {
  readonly migrate: Effect.Effect<void, Failure>
}

export const plan = (type: string, criteria: Criteria): Plan => {
  const values: Array<unknown> = [type]
  const clauses = criteria.map(([name, value]) => {
    values.push(type, name, value)
    return `exists (
      select 1 from resource_index i
      where i.surrogate_id = r.surrogate_id
        and i.resource_type = ? and i.name = ? and i.value = ?
    )`
  })
  const where = ["r.resource_type = ?", "r.is_current", "not r.deleted", ...clauses]
  return { where: where.join(" and "), values }
}

const classify = (cause: unknown): Failure =>
  String(cause).includes("Constraint Error")
    ? new Conflict({ reason: "version already written" })
    : new Unavailable({ dependency: "store" })

const rows = (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: classify
  })

const counted = (found: ReadonlyArray<Record<string, unknown>>): number =>
  found.reduce((total, row) => total + Number(row["n"]), 0)

const versionOf = (row: Record<string, unknown>): Version => ({
  type: String(row["type"]),
  id: String(row["id"]),
  versionId: Number(row["version_id"]),
  lastUpdated: String(row["last_updated"]),
  deleted: row["deleted"] === true,
  body: JSON.parse(String(row["body"])) as FhirResource
})

const indexed = (type: string, body: FhirResource) => {
  const definitions = parametersOf(type)
  if (definitions === undefined) return []
  return Object.entries(definitions).flatMap(([name, definition]) =>
    walk(body, definition.path).map((value) => ({ name, value }))
  )
}

const make = (connection: DuckDBConnection): Wired => {
  let last = 0

  const ask = (sql: string, values: ReadonlyArray<unknown> = []) =>
    rows(connection, sql, values)

  const atomic = <A>(work: Effect.Effect<A, Failure>): Effect.Effect<A, Failure> =>
    ask("begin transaction").pipe(
      Effect.zipRight(work),
      Effect.tap(() => ask("commit")),
      Effect.tapError(() => Effect.ignore(ask("rollback")))
    )

  const declared = (type: string, criteria: Criteria): Effect.Effect<void, Failure> => {
    const definitions = parametersOf(type)
    if (definitions === undefined) {
      return Effect.fail(new Rejected({ reason: `unsupported resource type: ${type}` }))
    }
    const unknown = criteria
      .map(([name]) => name)
      .filter((name) => definitions[name] === undefined)
    return unknown.length > 0
      ? Effect.fail(new Rejected({ reason: `unsupported criterion: ${unknown.join(", ")}` }))
      : Effect.void
  }

  const current = (type: string, id: string) =>
    ask(
      `select ${FIELDS} from resource r
       where resource_type = ? and logical_id = ? and is_current`,
      [type, id]
    ).pipe(Effect.map((found) => (found[0] === undefined ? undefined : versionOf(found[0]))))

  const versionAt = (type: string, id: string, versionId: number) =>
    ask(
      `select ${FIELDS} from resource r
       where resource_type = ? and logical_id = ? and version_id = ?`,
      [type, id, versionId]
    ).pipe(Effect.map((found) => (found[0] === undefined ? undefined : versionOf(found[0]))))

  const history = (type: string, id: string) =>
    ask(
      `select ${FIELDS} from resource r
       where resource_type = ? and logical_id = ?
       order by version_id desc`,
      [type, id]
    ).pipe(Effect.map((found) => found.map(versionOf)))

  const currents = (type: string, id: string) =>
    ask(
      `select count(*) as n from resource r
       where resource_type = ? and logical_id = ? and is_current`,
      [type, id]
    ).pipe(Effect.map(counted))

  const insertVersion = (entry: Version) =>
    atomic(
      Effect.gen(function* () {
        yield* ask(
          `update resource set is_current = false
           where resource_type = ? and logical_id = ? and is_current`,
          [entry.type, entry.id]
        )
        yield* ask(
          `insert into resource
             (surrogate_id, resource_type, logical_id, version_id,
              last_updated, deleted, is_current, body)
           values (nextval('surrogate_id'), ?, ?, ?, ?, ?, true, ?)`,
          [
            entry.type,
            entry.id,
            entry.versionId,
            entry.lastUpdated,
            entry.deleted,
            JSON.stringify(entry.body)
          ]
        )
        if (entry.deleted) return
        for (const row of indexed(entry.type, entry.body)) {
          yield* ask(
            `insert into resource_index (surrogate_id, resource_type, name, value)
             select surrogate_id, ?, ?, ? from resource
             where resource_type = ? and logical_id = ? and version_id = ?`,
            [entry.type, row.name, row.value, entry.type, entry.id, entry.versionId]
          )
        }
      })
    )

  const markDeleted = (type: string, id: string, versionId: number, lastUpdated: string) =>
    insertVersion({
      type,
      id,
      versionId,
      lastUpdated,
      deleted: true,
      body: { resourceType: type, id }
    })

  const purge = (type: string, id: string) =>
    atomic(
      Effect.gen(function* () {
        yield* ask(
          `delete from resource_index where surrogate_id in
             (select surrogate_id from resource
              where resource_type = ? and logical_id = ?)`,
          [type, id]
        )
        yield* ask(`delete from resource where resource_type = ? and logical_id = ?`, [
          type,
          id
        ])
      })
    )

  const matching = (type: string, criteria: Criteria) =>
    Effect.gen(function* () {
      yield* declared(type, criteria)
      const built = plan(type, criteria)
      const found = yield* ask(
        `select ${FIELDS} from resource r where ${built.where} order by r.surrogate_id`,
        built.values
      )
      return found.map(versionOf)
    })

  const tally = (type: string, criteria: Criteria) =>
    Effect.gen(function* () {
      yield* declared(type, criteria)
      const built = plan(type, criteria)
      const found = yield* ask(
        `select count(*) as n from resource r where ${built.where}`,
        built.values
      )
      return counted(found)
    })

  const mint = () => Effect.sync(() => randomUUID())

  const stamp = () =>
    Effect.sync(() => {
      const now = Date.now()
      last = now > last ? now : last + 1
      return new Date(last).toISOString()
    })

  const migrate = Effect.forEach(STATEMENTS, (statement) => ask(statement), {
    discard: true
  })

  return {
    current,
    versionAt,
    history,
    insertVersion,
    markDeleted,
    purge,
    matching,
    mint,
    stamp,
    currents,
    tally,
    migrate
  }
}

export const open = (path: string): Effect.Effect<Versioned, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: classify
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(
    Effect.flatMap((connection) => {
      const store = make(connection)
      return Effect.as(store.migrate, store)
    })
  )

export const layer = (path: string): Layer.Layer<Versions, Failure> =>
  Layer.scoped(Versions, open(path))
