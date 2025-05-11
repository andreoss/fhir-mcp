import { Effect, Either, Layer } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Manager } from "../compartment/definition.js"
import type { Limit } from "../compartment/filter.js"
import { plans, scoped } from "../compartment/search.js"
import type { Scoped } from "../compartment/search.js"
import { FhirEngine } from "../core/engine.js"
import type {
  Bundle,
  BundleEntry,
  Engine,
  FhirResource,
  SearchQuery
} from "../core/engine.js"
import { NotFound, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { admit } from "../params/gate.js"
import { ready } from "../params/model.js"
import type { Snapshot } from "../params/model.js"
import { parse } from "../search/parse.js"
import type { Query } from "../search/parse.js"
import { parametersOf, types } from "../store/definitions.js"
import type { Entry, Paging, Result } from "../store/query.js"
import type { Cache } from "./cache.js"
import { fingerprint, limits } from "./restriction.js"
import type { Restriction } from "./restriction.js"

export interface Deps {
  readonly connection: DuckDBConnection
  readonly manager: Manager
  readonly snapshot: Effect.Effect<Snapshot, Failure>
  readonly cache: Cache
}

export interface Restricted extends Engine {
  readonly prepare: (request: SearchQuery) => Effect.Effect<Scoped, Failure>
}

const READ = "read" as const

const MISMATCHED = "a cached plan did not match the key it was asked for"

const BROKEN = "a cached plan failed to run"

const rowsOf = (
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

const paged = (request: SearchQuery): Paging => ({
  ...(request.offset === undefined ? {} : { offset: request.offset }),
  ...(request.limit === undefined ? {} : { limit: request.limit })
})

const keyed = (
  restriction: Restriction,
  bound: ReadonlyArray<Limit>,
  epoch: number,
  request: SearchQuery
): string =>
  [
    fingerprint(restriction),
    JSON.stringify(bound),
    epoch,
    request.type,
    request.parameters.map(([name, value]) => `${name}=${value}`).join("&"),
    request.offset ?? 0,
    request.limit ?? -1
  ].join("|")

const carried = (entry: Entry): BundleEntry => {
  const id = entry.resource.id
  return id === undefined
    ? { resource: entry.resource }
    : { fullUrl: `${entry.resource.resourceType}/${id}`, resource: entry.resource }
}

const bundled = (result: Result): Bundle => ({
  resourceType: "Bundle",
  type: "searchset",
  ...(result.total === undefined ? {} : { total: result.total }),
  entry: result.entry.map(carried)
})

const simple = (query: Query): boolean =>
  query.controls.include.length === 0 && query.controls.revinclude.length === 0

export const engine = (deps: Deps, restriction: Restriction): Restricted => {
  const bounds = (type: string) =>
    limits(restriction, deps.manager, { action: READ, type })

  const ran = (query: Query, plan: Scoped): Effect.Effect<Result, Failure> =>
    Effect.gen(function* () {
      const total =
        query.controls.total === "none"
          ? undefined
          : yield* Effect.map(
              rowsOf(deps.connection, plan.count.sql, plan.count.values),
              (rows) => Number(rows[0]?.["total"] ?? 0)
            )
      const rows = yield* rowsOf(deps.connection, plan.page.sql, plan.page.values)
      return {
        total,
        entry: rows.map((row) => ({
          mode: "match" as const,
          resource: JSON.parse(String(row["body"])) as FhirResource
        }))
      }
    })

  const afresh = (
    query: Query,
    bound: ReadonlyArray<Limit>,
    paging: Paging
  ): Effect.Effect<Result, Failure> =>
    Effect.flatMap(plans(query, bound, paging), (plan) => ran(query, plan))

  const cached = (
    query: Query,
    bound: ReadonlyArray<Limit>,
    paging: Paging,
    key: string
  ): Effect.Effect<Result, Failure> =>
    Effect.gen(function* () {
      const state = yield* deps.cache.state
      if (!state.enabled) return yield* afresh(query, bound, paging)
      const held = yield* deps.cache.take(key)
      if (held === undefined) {
        const plan = yield* plans(query, bound, paging)
        yield* deps.cache.keep(key, plan)
        return yield* ran(query, plan)
      }
      if (held.key !== key) {
        yield* deps.cache.demote(MISMATCHED)
        return yield* afresh(query, bound, paging)
      }
      const found = yield* Effect.either(ran(query, held.plan))
      if (Either.isRight(found)) return found.right
      yield* deps.cache.demote(BROKEN)
      return yield* afresh(query, bound, paging)
    })

  const admitted = (request: SearchQuery) =>
    Effect.gen(function* () {
      const snapshot = yield* deps.snapshot
      yield* admit(snapshot, request.type, request.parameters)
      const query = yield* parse(request.type, request.parameters)
      const bound = yield* bounds(request.type)
      return { snapshot, query, bound, paging: paged(request) }
    })

  const search = (request: SearchQuery): Effect.Effect<Bundle, Failure> =>
    Effect.gen(function* () {
      const one = yield* admitted(request)
      const result = simple(one.query)
        ? yield* cached(
            one.query,
            one.bound,
            one.paging,
            keyed(restriction, one.bound, one.snapshot.epoch, request)
          )
        : yield* scoped(deps.connection, one.query, one.bound, one.paging)
      return bundled(result)
    })

  const prepare = (request: SearchQuery): Effect.Effect<Scoped, Failure> =>
    Effect.flatMap(admitted(request), (one) =>
      plans(one.query, one.bound, one.paging)
    )

  const read = (type: string, id: string): Effect.Effect<FhirResource, Failure> =>
    Effect.flatMap(
      search({ type, parameters: [["_id", id]], limit: 1 }),
      (bundle) => {
        const first = bundle.entry?.[0]?.resource
        return first === undefined
          ? Effect.fail(new NotFound({ type, id }))
          : Effect.succeed(first)
      }
    )

  const resourceTypes = (): Effect.Effect<ReadonlyArray<string>, Failure> =>
    Effect.map(
      Effect.forEach(types(), (type) =>
        Effect.map(Effect.either(bounds(type)), (found) =>
          Either.isRight(found) ? type : undefined
        )
      ),
      (found) => found.filter((type): type is string => type !== undefined)
    )

  const searchParameters = (
    type: string
  ): Effect.Effect<ReadonlyArray<string>, Failure> =>
    Effect.gen(function* () {
      if (parametersOf(type) === undefined) {
        return yield* Effect.fail(
          new Rejected({ reason: `unsupported resource type: ${type}` })
        )
      }
      yield* bounds(type)
      const snapshot = yield* deps.snapshot
      return [...snapshot.entries.values()]
        .filter((entry) => entry.definition.type === type && ready(entry))
        .map((entry) => entry.definition.name)
    })

  return { read, search, prepare, resourceTypes, searchParameters }
}

export const bound = (
  deps: Deps,
  restriction: Restriction
): Layer.Layer<FhirEngine> => Layer.succeed(FhirEngine, engine(deps, restriction))
