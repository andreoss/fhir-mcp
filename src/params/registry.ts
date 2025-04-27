import { Clock, Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Conflict, NotFound, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf } from "../store/definitions.js"
import { ensure } from "../store/query.js"
import type { Component, ValueType } from "../search/tree.js"
import { at, complete, key, permits, seed } from "./model.js"
import type {
  Change,
  Definition,
  Entry,
  Fault,
  Progress,
  Snapshot
} from "./model.js"

export const SCHEMA_VERSION = 1

const STATEMENTS: ReadonlyArray<string> = [
  `create table if not exists resource_index (
     surrogate_id bigint not null, resource_type varchar not null,
     name varchar not null, value varchar not null
   )`,
  `create table if not exists search_param (
     resource_type varchar not null, name varchar not null,
     value_type varchar not null, path varchar not null,
     targets varchar not null, components varchar not null,
     status varchar not null, version integer not null,
     updated_at varchar not null,
     primary key (resource_type, name)
   )`,
  `create table if not exists search_param_index (
     resource_type varchar not null, name varchar not null,
     done integer not null, total integer not null, failures integer not null,
     primary key (resource_type, name)
   )`,
  `create sequence if not exists search_param_fault_seq start 1`,
  `create table if not exists search_param_fault (
     ordinal bigint not null, resource_type varchar not null,
     name varchar not null, logical_id varchar not null, reason varchar not null
   )`,
  `create table if not exists search_param_epoch (
     id integer not null primary key, epoch bigint not null
   )`,
  `create table if not exists search_param_schema (
     version integer not null primary key, applied_at timestamp not null
   )`
]

const INDEXES: ReadonlyArray<string> = [
  "resource_index",
  "index_token",
  "index_number",
  "index_date",
  "index_quantity",
  "index_reference"
]

const FIELDS = `p.resource_type as resource_type, p.name as name,
  p.value_type as value_type, p.path as path, p.targets as targets,
  p.components as components, p.status as status, p.version as version,
  p.updated_at as updated_at, coalesce(x.done, 0) as done,
  coalesce(x.total, 0) as total, coalesce(x.failures, 0) as failures`

const SOURCE = `from search_param p left join search_param_index x
  on x.resource_type = p.resource_type and x.name = p.name`

export interface View {
  readonly entry: Entry | undefined
  readonly rows: number
}

export interface Registry {
  readonly migrate: Effect.Effect<void, Failure>
  readonly install: Effect.Effect<void, Failure>
  readonly epoch: Effect.Effect<number, Failure>
  readonly all: Effect.Effect<ReadonlyArray<Entry>, Failure>
  readonly snapshot: Effect.Effect<Snapshot, Failure>
  readonly find: (type: string, name: string) => Effect.Effect<Entry, Failure>
  readonly view: (type: string, name: string) => Effect.Effect<View, Failure>
  readonly create: (definition: Definition) => Effect.Effect<Entry, Failure>
  readonly revise: (
    definition: Definition,
    expected: number
  ) => Effect.Effect<Entry, Failure>
  readonly remove: (
    type: string,
    name: string,
    expected: number
  ) => Effect.Effect<void, Failure>
  readonly advance: (change: Change) => Effect.Effect<Entry, Failure>
  readonly record: (progress: Progress) => Effect.Effect<Entry, Failure>
  readonly faults: (
    type: string,
    name: string
  ) => Effect.Effect<ReadonlyArray<Fault>, Failure>
  readonly indexed: (type: string, name: string) => Effect.Effect<number, Failure>
}

const classify = (cause: unknown): Failure => {
  const text = String(cause)
  if (text.includes("Constraint Error")) {
    return new Conflict({ reason: "search parameter already registered" })
  }
  if (text.includes("Conflict on")) {
    return new Conflict({ reason: "search parameter changed concurrently" })
  }
  return new Unavailable({ dependency: "store" })
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
    catch: classify
  })

const refuse = (reason: string): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason }))

const missing = (type: string, name: string): Failure =>
  new NotFound({ type: "SearchParameter", id: at(type, name) })

const listed = (value: unknown): ReadonlyArray<string> =>
  JSON.parse(String(value)) as ReadonlyArray<string>

const entryOf = (row: Record<string, unknown>): Entry => ({
  definition: {
    type: String(row["resource_type"]),
    name: String(row["name"]),
    valueType: String(row["value_type"]) as ValueType,
    path: listed(row["path"]),
    targets: listed(row["targets"]),
    components: JSON.parse(String(row["components"])) as ReadonlyArray<Component>
  },
  status: String(row["status"]) as Entry["status"],
  version: Number(row["version"]),
  done: Number(row["done"]),
  total: Number(row["total"]),
  failures: Number(row["failures"]),
  updatedAt: String(row["updated_at"])
})

const sound = (definition: Definition): Effect.Effect<void, Failure> => {
  const where = at(definition.type, definition.name)
  if (parametersOf(definition.type) === undefined) {
    return refuse(`unsupported resource type: ${definition.type}`)
  }
  if (definition.name.trim().length === 0) {
    return refuse("search parameter carries no name")
  }
  if (definition.path.length === 0) {
    return refuse(`${where}: search parameter carries no path`)
  }
  if (definition.valueType === "composite") {
    return refuse(`${where}: a composite parameter cannot be indexed`)
  }
  return Effect.void
}

const make = (
  connection: DuckDBConnection,
  gate: Effect.Semaphore
): Registry => {
  const ask = (sql: string, values: ReadonlyArray<unknown> = []) =>
    rows(connection, sql, values)

  const atomic = <A>(work: Effect.Effect<A, Failure>): Effect.Effect<A, Failure> =>
    gate.withPermits(1)(
      ask("begin transaction").pipe(
        Effect.zipRight(work),
        Effect.tap(() => ask("commit")),
        Effect.tapError(() => Effect.ignore(ask("rollback")))
      )
    )

  const stamp = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => new Date(millis).toISOString())
  )

  const bump = Effect.asVoid(
    ask(`update search_param_epoch set epoch = epoch + 1 where id = 0`)
  )

  const epoch = ask(`select epoch from search_param_epoch where id = 0`).pipe(
    Effect.map((found) => Number(found[0]?.["epoch"] ?? 0))
  )

  const all = ask(
    `select ${FIELDS} ${SOURCE} order by p.resource_type, p.name`
  ).pipe(Effect.map((found) => found.map(entryOf)))

  const find = (type: string, name: string) =>
    ask(`select ${FIELDS} ${SOURCE} where p.resource_type = ? and p.name = ?`, [
      type,
      name
    ]).pipe(
      Effect.flatMap((found) => {
        const row = found[0]
        return row === undefined
          ? Effect.fail<Failure>(missing(type, name))
          : Effect.succeed(entryOf(row))
      })
    )

  const purge = (type: string, name: string) =>
    Effect.forEach(
      INDEXES,
      (table) =>
        ask(`delete from ${table} where resource_type = ? and name = ?`, [type, name]),
      { discard: true }
    )

  const clear = (type: string, name: string) =>
    Effect.gen(function* () {
      yield* purge(type, name)
      yield* ask(
        `delete from search_param_fault where resource_type = ? and name = ?`,
        [type, name]
      )
    })

  const guard = (type: string, name: string, expected: number) =>
    Effect.gen(function* () {
      const found = yield* ask(
        `select ${FIELDS} ${SOURCE} where p.resource_type = ? and p.name = ?`,
        [type, name]
      )
      const row = found[0]
      if (row === undefined) return yield* Effect.fail<Failure>(missing(type, name))
      const held = entryOf(row)
      if (held.version !== expected) {
        return yield* Effect.fail<Failure>(
          new Conflict({
            reason: `${at(type, name)}: expected version ${expected}, found ${held.version}`
          })
        )
      }
      return held
    })

  const applied = (
    found: ReadonlyArray<Record<string, unknown>>,
    type: string,
    name: string
  ): Effect.Effect<void, Failure> =>
    found.length === 0
      ? Effect.fail(
          new Conflict({ reason: `${at(type, name)}: changed while it was being written` })
        )
      : Effect.void

  const create = (definition: Definition) =>
    Effect.gen(function* () {
      yield* sound(definition)
      const now = yield* stamp
      const { name, type } = definition
      yield* atomic(
        Effect.gen(function* () {
          yield* clear(type, name)
          yield* ask(
            `delete from search_param_index where resource_type = ? and name = ?`,
            [type, name]
          )
          yield* ask(
            `insert into search_param_index (resource_type, name, done, total, failures)
             values (?, ?, 0, 0, 0)`,
            [type, name]
          )
          yield* ask(
            `insert into search_param (resource_type, name, value_type, path,
               targets, components, status, version, updated_at)
             values (?, ?, ?, ?, ?, ?, 'draft', 1, ?)`,
            [
              type,
              name,
              definition.valueType,
              JSON.stringify(definition.path),
              JSON.stringify(definition.targets),
              JSON.stringify(definition.components),
              now
            ]
          )
          yield* bump
        })
      )
      return yield* find(type, name)
    })

  const revise = (definition: Definition, expected: number) =>
    Effect.gen(function* () {
      yield* sound(definition)
      const now = yield* stamp
      const { name, type } = definition
      yield* atomic(
        Effect.gen(function* () {
          yield* guard(type, name, expected)
          yield* clear(type, name)
          yield* ask(
            `update search_param_index set done = 0, total = 0, failures = 0
             where resource_type = ? and name = ?`,
            [type, name]
          )
          const changed = yield* ask(
            `update search_param set value_type = ?, path = ?, targets = ?,
               components = ?, status = 'draft', version = version + 1,
               updated_at = ?
             where resource_type = ? and name = ? and version = ?
             returning version`,
            [
              definition.valueType,
              JSON.stringify(definition.path),
              JSON.stringify(definition.targets),
              JSON.stringify(definition.components),
              now,
              type,
              name,
              expected
            ]
          )
          yield* applied(changed, type, name)
          yield* bump
        })
      )
      return yield* find(type, name)
    })

  const remove = (type: string, name: string, expected: number) =>
    atomic(
      Effect.gen(function* () {
        yield* guard(type, name, expected)
        yield* clear(type, name)
        yield* ask(
          `delete from search_param_index where resource_type = ? and name = ?`,
          [type, name]
        )
        const gone = yield* ask(
          `delete from search_param where resource_type = ? and name = ? and version = ?
           returning name`,
          [type, name, expected]
        )
        yield* applied(gone, type, name)
        yield* bump
      })
    )

  const advance = (change: Change) =>
    Effect.gen(function* () {
      const now = yield* stamp
      yield* atomic(
        Effect.gen(function* () {
          const held = yield* guard(change.type, change.name, change.version)
          const where = at(change.type, change.name)
          if (!permits(held.status, change.status)) {
            return yield* refuse(
              `${where}: ${held.status} does not become ${change.status}`
            )
          }
          if (change.status === "active" && !complete(held)) {
            return yield* Effect.fail<Failure>(
              new Conflict({
                reason:
                  `${where}: backfill covers ${held.done} of ${held.total}` +
                  ` with ${held.failures} failed`
              })
            )
          }
          const changed = yield* ask(
            `update search_param set status = ?, version = version + 1, updated_at = ?
             where resource_type = ? and name = ? and version = ?
             returning version`,
            [change.status, now, change.type, change.name, change.version]
          )
          yield* applied(changed, change.type, change.name)
          yield* bump
        })
      )
      return yield* find(change.type, change.name)
    })

  const record = (progress: Progress) =>
    Effect.gen(function* () {
      const { name, type } = progress
      yield* atomic(
        Effect.gen(function* () {
          yield* guard(type, name, progress.version)
          const changed = yield* ask(
            `update search_param_index set done = ?, total = ?,
               failures = failures + ?
             where resource_type = ? and name = ? returning done`,
            [progress.done, progress.total, progress.faults.length, type, name]
          )
          yield* applied(changed, type, name)
          yield* Effect.forEach(
            progress.faults,
            (fault) =>
              ask(
                `insert into search_param_fault
                   (ordinal, resource_type, name, logical_id, reason)
                 values (nextval('search_param_fault_seq'), ?, ?, ?, ?)`,
                [type, name, fault.id, fault.reason]
              ),
            { discard: true }
          )
        })
      )
      return yield* find(type, name)
    })

  const faults = (type: string, name: string) =>
    ask(
      `select logical_id, reason from search_param_fault
       where resource_type = ? and name = ? order by ordinal`,
      [type, name]
    ).pipe(
      Effect.map((found) =>
        found.map((row) => ({
          id: String(row["logical_id"]),
          reason: String(row["reason"])
        }))
      )
    )

  const indexed = (type: string, name: string) =>
    Effect.forEach(INDEXES, (table) =>
      ask(
        `select count(*) as n from ${table} where resource_type = ? and name = ?`,
        [type, name]
      )
    ).pipe(
      Effect.map((all) =>
        all.reduce((total, found) => total + Number(found[0]?.["n"] ?? 0), 0)
      )
    )

  const snapshot = atomic(
    Effect.gen(function* () {
      const seen = yield* epoch
      const found = yield* all
      return { epoch: seen, entries: new Map(found.map((one) => [key(one), one])) }
    })
  )

  const view = (type: string, name: string) =>
    atomic(
      Effect.gen(function* () {
        const found = yield* ask(
          `select ${FIELDS} ${SOURCE} where p.resource_type = ? and p.name = ?`,
          [type, name]
        )
        const row = found[0]
        const counted = yield* Effect.forEach(INDEXES, (table) =>
          ask(`select count(*) as n from ${table} where resource_type = ? and name = ?`, [
            type,
            name
          ])
        )
        return {
          entry: row === undefined ? undefined : entryOf(row),
          rows: counted.reduce((total, one) => total + Number(one[0]?.["n"] ?? 0), 0)
        }
      })
    )

  const install = Effect.gen(function* () {
    const now = yield* stamp
    yield* atomic(
      Effect.forEach(
        seed(),
        (definition) =>
          Effect.gen(function* () {
            yield* ask(
              `insert into search_param (resource_type, name, value_type, path,
                 targets, components, status, version, updated_at)
               select ?, ?, ?, ?, ?, ?, 'active', 1, ?
               where not exists (
                 select 1 from search_param where resource_type = ? and name = ?
               )`,
              [
                definition.type,
                definition.name,
                definition.valueType,
                JSON.stringify(definition.path),
                JSON.stringify(definition.targets),
                JSON.stringify(definition.components),
                now,
                definition.type,
                definition.name
              ]
            )
            yield* ask(
              `insert into search_param_index (resource_type, name, done, total, failures)
               select ?, ?, 0, 0, 0
               where not exists (
                 select 1 from search_param_index where resource_type = ? and name = ?
               )`,
              [definition.type, definition.name, definition.type, definition.name]
            )
          }),
        { discard: true }
      ).pipe(Effect.zipRight(bump))
    )
  })

  const migrate = Effect.gen(function* () {
    yield* ensure(connection)
    yield* Effect.forEach(STATEMENTS, (statement) => ask(statement), { discard: true })
    yield* ask(
      `insert into search_param_epoch (id, epoch)
       select 0, 0 where not exists (select 1 from search_param_epoch where id = 0)`
    )
    yield* ask(
      `insert into search_param_schema (version, applied_at)
       select ?, current_timestamp
       where not exists (select 1 from search_param_schema where version = ?)`,
      [SCHEMA_VERSION, SCHEMA_VERSION]
    )
  })

  return {
    migrate,
    install,
    epoch,
    all,
    snapshot,
    find,
    view,
    create,
    revise,
    remove,
    advance,
    record,
    faults,
    indexed
  }
}

export const registryOn = (
  connection: DuckDBConnection
): Effect.Effect<Registry, Failure> =>
  Effect.gen(function* () {
    const gate = yield* Effect.makeSemaphore(1)
    const registry = make(connection, gate)
    yield* registry.migrate
    return registry
  })
