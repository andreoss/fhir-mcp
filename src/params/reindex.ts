import { Context, Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Conflict, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { walk } from "../store/definitions.js"
import { index } from "../store/query.js"
import type { IndexEntry } from "../store/query.js"
import { at } from "./model.js"
import type { Definition, Fault, Status } from "./model.js"
import type { Registry } from "./registry.js"

export const BATCH = 200

export interface Slice {
  readonly type: string
  readonly name: string
  readonly version: number
}

export interface Queue {
  readonly submit: (slice: Slice) => Effect.Effect<string, Failure>
}

export class Reindexer extends Context.Tag("params/Reindexer")<Reindexer, Queue>() {}

export interface Run {
  readonly done: number
  readonly total: number
  readonly faults: ReadonlyArray<Fault>
  readonly status: Status
}

export type Emission =
  | { readonly _tag: "Typed"; readonly entry: IndexEntry }
  | { readonly _tag: "Plain"; readonly value: string }
  | { readonly _tag: "Refused"; readonly reason: string }

const ABSOLUTE = /^https?:\/\//

export const emit = (definition: Definition, value: string): Emission => {
  const name = definition.name
  const where = at(definition.type, name)
  switch (definition.valueType) {
    case "string":
    case "uri":
      return { _tag: "Plain", value }
    case "token":
      return {
        _tag: "Typed",
        entry: { kind: "token", name, system: undefined, code: value, text: value }
      }
    case "number": {
      const held = Number(value)
      return Number.isFinite(held)
        ? { _tag: "Typed", entry: { kind: "number", name, value: held } }
        : { _tag: "Refused", reason: `${where}: not a number: ${value}` }
    }
    case "quantity": {
      const held = Number(value)
      return Number.isFinite(held)
        ? {
            _tag: "Typed",
            entry: {
              kind: "quantity",
              name,
              value: held,
              system: undefined,
              code: undefined
            }
          }
        : { _tag: "Refused", reason: `${where}: not a number: ${value}` }
    }
    case "date": {
      const held = Date.parse(value)
      if (Number.isNaN(held)) {
        return { _tag: "Refused", reason: `${where}: not a date: ${value}` }
      }
      const moment = new Date(held).toISOString()
      return { _tag: "Typed", entry: { kind: "date", name, low: moment, high: moment } }
    }
    case "reference": {
      if (ABSOLUTE.test(value)) {
        return {
          _tag: "Typed",
          entry: {
            kind: "reference",
            name,
            targetType: undefined,
            targetId: undefined,
            url: value,
            idSystem: undefined,
            idCode: undefined
          }
        }
      }
      const parts = value.split("/")
      return {
        _tag: "Typed",
        entry: {
          kind: "reference",
          name,
          targetType: parts.length === 2 ? parts[0] : undefined,
          targetId: parts[parts.length - 1] ?? value,
          url: undefined,
          idSystem: undefined,
          idCode: undefined
        }
      }
    }
    case "composite":
      return {
        _tag: "Refused",
        reason: `${where}: a composite parameter cannot be indexed`
      }
  }
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

const written = (
  connection: DuckDBConnection,
  definition: Definition,
  surrogate: bigint,
  value: string
): Effect.Effect<string | undefined, Failure> => {
  const found = emit(definition, value)
  if (found._tag === "Refused") return Effect.succeed(found.reason)
  if (found._tag === "Plain") {
    return rows(
      connection,
      `insert into resource_index (surrogate_id, resource_type, name, value)
       values (?, ?, ?, ?)`,
      [surrogate, definition.type, definition.name, found.value]
    ).pipe(Effect.as(undefined))
  }
  return index(connection, surrogate, definition.type, [found.entry]).pipe(
    Effect.as(undefined)
  )
}

const covered = (
  connection: DuckDBConnection,
  definition: Definition,
  row: Record<string, unknown>
): Effect.Effect<ReadonlyArray<Fault>, Failure> => {
  const id = String(row["logical_id"])
  const surrogate = BigInt(String(row["surrogate_id"]))
  return Effect.try({
    try: () => JSON.parse(String(row["body"])) as unknown,
    catch: () => `${at(definition.type, definition.name)}: unreadable body`
  }).pipe(
    Effect.matchEffect({
      onFailure: (reason) => Effect.succeed([{ id, reason }]),
      onSuccess: (body) =>
        Effect.forEach(walk(body, definition.path), (value) =>
          written(connection, definition, surrogate, value)
        ).pipe(
          Effect.map((found) =>
            found
              .filter((one): one is string => one !== undefined)
              .map((reason) => ({ id, reason }))
          )
        )
    })
  )
}

export const backfill = (
  connection: DuckDBConnection,
  registry: Registry,
  slice: Slice,
  batch: number = BATCH
): Effect.Effect<Run, Failure> =>
  Effect.gen(function* () {
    const held = yield* registry.find(slice.type, slice.name)
    const where = at(slice.type, slice.name)
    if (held.version !== slice.version) {
      return yield* Effect.fail(
        new Conflict({
          reason:
            `${where}: the job names version ${slice.version},` +
            ` the registry holds ${held.version}`
        })
      )
    }
    const started = yield* registry.advance({
      type: slice.type,
      name: slice.name,
      status: "backfilling",
      version: held.version
    })
    const version = started.version
    const definition = started.definition
    const counted = yield* rows(
      connection,
      `select count(*) as n from resource
       where resource_type = ? and is_current and not deleted`,
      [slice.type]
    )
    const total = Number(counted[0]?.["n"] ?? 0)
    const faults: Array<Fault> = []
    let done = 0
    for (;;) {
      const page = yield* rows(
        connection,
        `select surrogate_id, logical_id, body from resource
         where resource_type = ? and is_current and not deleted
         order by surrogate_id limit ? offset ?`,
        [slice.type, batch, done]
      )
      if (page.length === 0) break
      const found = yield* Effect.forEach(page, (row) =>
        covered(connection, definition, row)
      )
      const fresh = found.flat()
      faults.push(...fresh)
      done += page.length
      yield* registry.record({
        type: slice.type,
        name: slice.name,
        version,
        done,
        total,
        faults: fresh
      })
      if (page.length < batch) break
    }
    yield* registry.record({
      type: slice.type,
      name: slice.name,
      version,
      done,
      total,
      faults: []
    })
    const ended = yield* registry.advance({
      type: slice.type,
      name: slice.name,
      status: faults.length === 0 ? "active" : "failed",
      version
    })
    return { done, total, faults, status: ended.status }
  })
