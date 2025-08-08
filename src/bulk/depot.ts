import { Context, Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf, walk } from "../store/definitions.js"
import type { Plan } from "../store/versioned.js"

export const STATEMENTS: ReadonlyArray<string> = [
  `create table if not exists bulk_file (
     path varchar primary key,
     rows integer not null,
     body varchar not null
   )`,
  `create table if not exists bulk_note (
     job_id varchar primary key,
     kind varchar not null,
     container varchar not null,
     location varchar,
     etag varchar,
     detail varchar not null
   )`,
  `create table if not exists bulk_tally (
     unit_id varchar primary key,
     job_id varchar not null,
     res_type varchar not null,
     path varchar,
     written integer not null,
     skipped integer not null,
     failed integer not null,
     scanned integer not null
   )`,
  `create table if not exists bulk_fault (
     job_id varchar not null,
     unit_id varchar not null,
     res_type varchar not null,
     logical_id varchar,
     line integer,
     reason varchar not null
   )`,
  `create index if not exists bulk_tally_owner on bulk_tally (job_id)`,
  `create index if not exists bulk_fault_owner on bulk_fault (job_id, unit_id)`
]

export interface Sheet {
  readonly path: string
  readonly rows: number
}

export interface Note {
  readonly job: string
  readonly kind: string
  readonly container: string
  readonly location: string | undefined
  readonly etag: string | undefined
  readonly detail: string
}

export interface Tally {
  readonly job: string
  readonly unit: string
  readonly type: string
  readonly path: string | undefined
  readonly written: number
  readonly skipped: number
  readonly failed: number
  readonly scanned: number
}

export interface Item {
  readonly type: string
  readonly id: string | undefined
  readonly line: number | undefined
  readonly reason: string
}

export interface Fault extends Item {
  readonly job: string
  readonly unit: string
}

export interface Target {
  readonly surrogate: bigint
  readonly type: string
  readonly body: FhirResource
}

export interface Depot {
  readonly put: (
    path: string,
    lines: ReadonlyArray<string>
  ) => Effect.Effect<void, Failure>
  readonly get: (path: string) => Effect.Effect<ReadonlyArray<string>, Failure>
  readonly list: (
    prefix: string
  ) => Effect.Effect<ReadonlyArray<Sheet>, Failure>
  readonly note: (record: Note) => Effect.Effect<void, Failure>
  readonly noted: (job: string) => Effect.Effect<Note | undefined, Failure>
  readonly mark: (record: Tally) => Effect.Effect<void, Failure>
  readonly marks: (job: string) => Effect.Effect<ReadonlyArray<Tally>, Failure>
  readonly fault: (
    job: string,
    unit: string,
    items: ReadonlyArray<Item>
  ) => Effect.Effect<void, Failure>
  readonly faults: (job: string) => Effect.Effect<ReadonlyArray<Fault>, Failure>
  readonly ids: (
    type: string,
    deleted: boolean
  ) => Effect.Effect<ReadonlyArray<string>, Failure>
  readonly targets: (
    type: string | undefined,
    ids: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Target>, Failure>
  readonly refresh: (target: Target) => Effect.Effect<number, Failure>
}

export class DepotPort extends Context.Tag("Depot")<DepotPort, Depot>() {}

const asFailure = (): Failure => new Unavailable({ dependency: "store" })

const words = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value)

const count = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value)

export const narrow = (
  type: string | undefined,
  ids: ReadonlyArray<string>
): Plan => {
  const values: Array<unknown> = []
  const where = ["is_current", "not deleted"]
  if (type !== undefined) {
    where.push("resource_type = ?")
    values.push(type)
  }
  if (ids.length > 0) {
    where.push(`logical_id in (${ids.map(() => "?").join(",")})`)
    values.push(...ids)
  }
  return { where: where.join(" and "), values }
}

const entries = (type: string, body: FhirResource) => {
  const definitions = parametersOf(type)
  if (definitions === undefined) return []
  return Object.entries(definitions).flatMap(([name, definition]) =>
    walk(body, definition.path).map((value) => ({ name, value }))
  )
}

const make = (connection: DuckDBConnection): Depot & {
  readonly migrate: Effect.Effect<void, Failure>
} => {
  const ask = (sql: string, values: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: async () => {
        const reader = await connection.runAndReadAll(sql, [...values] as never)
        return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
      },
      catch: asFailure
    })

  const migrate = Effect.forEach(STATEMENTS, (sql) => ask(sql), {
    discard: true
  })

  const put = (path: string, lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* ask(`delete from bulk_file where path = ?`, [path])
      yield* ask(`insert into bulk_file values (?, ?, ?)`, [
        path,
        lines.length,
        lines.join("\n")
      ])
    })

  const get = (path: string) =>
    ask(`select body from bulk_file where path = ?`, [path]).pipe(
      Effect.map((found) => {
        const body = found[0]?.["body"]
        if (body === undefined) return []
        const text = String(body)
        return text.length === 0 ? [] : text.split("\n")
      })
    )

  const list = (prefix: string) =>
    ask(
      `select path, rows from bulk_file where starts_with(path, ?)
       order by path`,
      [prefix]
    ).pipe(
      Effect.map((found) =>
        found.map((row) => ({
          path: String(row["path"]),
          rows: Number(row["rows"])
        }))
      )
    )

  const note = (record: Note) =>
    Effect.gen(function* () {
      yield* ask(`delete from bulk_note where job_id = ?`, [record.job])
      yield* ask(`insert into bulk_note values (?, ?, ?, ?, ?, ?)`, [
        record.job,
        record.kind,
        record.container,
        record.location ?? null,
        record.etag ?? null,
        record.detail
      ])
    })

  const noted = (job: string) =>
    ask(
      `select job_id, kind, container, location, etag, detail
       from bulk_note where job_id = ?`,
      [job]
    ).pipe(
      Effect.map((found) => {
        const row = found[0]
        return row === undefined
          ? undefined
          : {
              job: String(row["job_id"]),
              kind: String(row["kind"]),
              container: String(row["container"]),
              location: words(row["location"]),
              etag: words(row["etag"]),
              detail: String(row["detail"])
            }
      })
    )

  const mark = (record: Tally) =>
    Effect.gen(function* () {
      yield* ask(`delete from bulk_tally where unit_id = ?`, [record.unit])
      yield* ask(`insert into bulk_tally values (?, ?, ?, ?, ?, ?, ?, ?)`, [
        record.unit,
        record.job,
        record.type,
        record.path ?? null,
        record.written,
        record.skipped,
        record.failed,
        record.scanned
      ])
    })

  const marks = (job: string) =>
    ask(
      `select unit_id, job_id, res_type, path, written, skipped, failed,
         scanned
       from bulk_tally where job_id = ? order by unit_id`,
      [job]
    ).pipe(
      Effect.map((found) =>
        found.map((row) => ({
          job: String(row["job_id"]),
          unit: String(row["unit_id"]),
          type: String(row["res_type"]),
          path: words(row["path"]),
          written: Number(row["written"]),
          skipped: Number(row["skipped"]),
          failed: Number(row["failed"]),
          scanned: Number(row["scanned"])
        }))
      )
    )

  const fault = (job: string, unit: string, items: ReadonlyArray<Item>) =>
    Effect.gen(function* () {
      yield* ask(`delete from bulk_fault where unit_id = ?`, [unit])
      for (const item of items) {
        yield* ask(`insert into bulk_fault values (?, ?, ?, ?, ?, ?)`, [
          job,
          unit,
          item.type,
          item.id ?? null,
          item.line ?? null,
          item.reason
        ])
      }
    })

  const faults = (job: string) =>
    ask(
      `select job_id, unit_id, res_type, logical_id, line, reason
       from bulk_fault where job_id = ?
       order by res_type, line, logical_id`,
      [job]
    ).pipe(
      Effect.map((found) =>
        found.map((row) => ({
          job: String(row["job_id"]),
          unit: String(row["unit_id"]),
          type: String(row["res_type"]),
          id: words(row["logical_id"]),
          line: count(row["line"]),
          reason: String(row["reason"])
        }))
      )
    )

  const ids = (type: string, deleted: boolean) =>
    ask(
      `select logical_id from resource
       where resource_type = ? and is_current and deleted = ?
       order by logical_id`,
      [type, deleted]
    ).pipe(Effect.map((found) => found.map((row) => String(row["logical_id"]))))

  const targets = (type: string | undefined, given: ReadonlyArray<string>) => {
    const built = narrow(type, given)
    return ask(
      `select surrogate_id, resource_type, body from resource
       where ${built.where} order by surrogate_id`,
      built.values
    ).pipe(
      Effect.map((found) =>
        found.map((row) => ({
          surrogate: BigInt(String(row["surrogate_id"])),
          type: String(row["resource_type"]),
          body: JSON.parse(String(row["body"])) as FhirResource
        }))
      )
    )
  }

  const refresh = (target: Target) =>
    Effect.gen(function* () {
      yield* ask(`delete from resource_index where surrogate_id = ?`, [
        target.surrogate
      ])
      const rows = entries(target.type, target.body)
      for (const row of rows) {
        yield* ask(`insert into resource_index values (?, ?, ?, ?)`, [
          target.surrogate,
          target.type,
          row.name,
          row.value
        ])
      }
      return rows.length
    })

  return {
    put,
    get,
    list,
    note,
    noted,
    mark,
    marks,
    fault,
    faults,
    ids,
    targets,
    refresh,
    migrate
  }
}

export const depotOn = (
  connection: DuckDBConnection
): Effect.Effect<Depot, Failure> => {
  const depot = make(connection)
  return Effect.as(depot.migrate, depot)
}
