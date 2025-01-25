import { Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Include } from "../search/control.js"
import type { Query } from "../search/parse.js"
import { plan } from "../store/query.js"
import type { Entry, Frag, Paging, Result } from "../store/query.js"
import type { Manager } from "./definition.js"
import { inside, restricted } from "./filter.js"
import type { Limit } from "./filter.js"

export interface Scoped {
  readonly count: Frag
  readonly page: Frag
  readonly include: Frag | undefined
  readonly revinclude: Frag | undefined
}

const ROUNDS = 3

const frag = (sql: string, values: ReadonlyArray<unknown> = []): Frag => ({ sql, values })

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

interface Reached {
  readonly surrogate: unknown
  readonly type: string
  readonly id: string
  readonly body: string
}

const reached = (row: Record<string, unknown>): Reached => ({
  surrogate: row["surrogate_id"],
  type: String(row["resource_type"]),
  id: String(row["logical_id"]),
  body: String(row["body"])
})

const driver = (page: Frag): Frag =>
  frag(
    `(select surrogate_id, resource_type, logical_id from (${page.sql}) d)`,
    page.values
  )

const seeds = (list: ReadonlyArray<Reached>): Frag =>
  frag(
    `(${list
      .map(
        () =>
          `select cast(? as bigint) as surrogate_id,` +
          ` cast(? as varchar) as resource_type,` +
          ` cast(? as varchar) as logical_id`
      )
      .join(" union all ")})`,
    list.flatMap((one) => [one.surrogate, one.type, one.id])
  )

const wanted = (list: ReadonlyArray<Include>, alias: string): Frag => {
  const parts: Array<string> = []
  const values: Array<unknown> = []
  for (const one of list) {
    if (one.wildcard && one.source === "*") {
      parts.push("true")
      continue
    }
    const bits = [`${alias}.resource_type = ?`]
    values.push(one.source)
    if (!one.wildcard) {
      bits.push(`${alias}.name = ?`)
      values.push(one.param)
    }
    if (one.target !== undefined) {
      bits.push(`${alias}.target_type = ?`)
      values.push(one.target)
    }
    parts.push(`(${bits.join(" and ")})`)
  }
  return frag(parts.length === 0 ? "false" : parts.join(" or "), values)
}

const step = (
  source: Frag,
  list: ReadonlyArray<Include>,
  forward: boolean,
  limits: ReadonlyArray<Limit>
): Frag => {
  const match = wanted(list, "x")
  const bound = inside(limits, "t", "k")
  const link = forward
    ? ` join index_reference x on x.surrogate_id = p.surrogate_id` +
      ` join resource t on t.resource_type = x.target_type` +
      ` and t.logical_id = x.target_id`
    : ` join index_reference x on x.target_type = p.resource_type` +
      ` and x.target_id = p.logical_id` +
      ` join resource t on t.surrogate_id = x.surrogate_id`
  return frag(
    `with page as ${source.sql} select distinct t.surrogate_id as surrogate_id,` +
      ` t.resource_type as resource_type, t.logical_id as logical_id,` +
      ` t.body as body from page p${link}` +
      ` where t.is_current and not t.deleted and (${match.sql}) and (${bound.sql})`,
    [...source.values, ...match.values, ...bound.values]
  )
}

const first = (
  page: Frag,
  list: ReadonlyArray<Include>,
  forward: boolean,
  limits: ReadonlyArray<Limit>
): Frag | undefined =>
  list.length === 0 ? undefined : step(driver(page), list, forward, limits)

const walk = (
  connection: DuckDBConnection,
  page: Frag,
  list: ReadonlyArray<Include>,
  forward: boolean,
  limits: ReadonlyArray<Limit>,
  seen: Set<string>
): Effect.Effect<ReadonlyArray<Reached>, Failure> =>
  Effect.gen(function* () {
    if (list.length === 0) return []
    const iterating = list.filter((one) => one.iterate)
    const out: Array<Reached> = []
    let source = driver(page)
    let current = list
    for (let round = 0; round < ROUNDS; round++) {
      const built = step(source, current, forward, limits)
      const rows = yield* rowsOf(connection, built.sql, built.values)
      const fresh: Array<Reached> = []
      for (const row of rows) {
        const one = reached(row)
        const at = `${one.type}/${one.id}`
        if (seen.has(at)) continue
        seen.add(at)
        fresh.push(one)
      }
      out.push(...fresh)
      current = iterating
      if (fresh.length === 0 || current.length === 0) break
      source = seeds(fresh)
    }
    return out
  })

export const within = (
  manager: Manager,
  code: string,
  id: string,
  limits: ReadonlyArray<Limit>
): Effect.Effect<ReadonlyArray<Limit>, Failure> =>
  Effect.map(manager.get(code), (definition) => [
    { definition, ids: [id] },
    ...limits
  ])

export const plans = (
  query: Query,
  limits: ReadonlyArray<Limit>,
  paging: Paging = {}
): Effect.Effect<Scoped, Failure> =>
  Effect.map(plan(restricted(query, limits), paging), (built) => ({
    count: built.count,
    page: built.page,
    include: first(built.page, query.controls.include, true, limits),
    revinclude: first(built.page, query.controls.revinclude, false, limits)
  }))

export const scoped = (
  connection: DuckDBConnection,
  query: Query,
  limits: ReadonlyArray<Limit>,
  paging: Paging = {}
): Effect.Effect<Result, Failure> =>
  Effect.gen(function* () {
    const built = yield* plan(restricted(query, limits), paging)
    const total =
      query.controls.total === "none"
        ? undefined
        : yield* Effect.map(
            rowsOf(connection, built.count.sql, built.count.values),
            (rows) => Number(rows[0]?.["total"] ?? 0)
          )
    const rows = yield* rowsOf(connection, built.page.sql, built.page.values)
    const matches = rows.map(reached)
    const seen = new Set(matches.map((one) => `${one.type}/${one.id}`))
    const controls = query.controls
    const forward = yield* walk(
      connection,
      built.page,
      controls.include,
      true,
      limits,
      seen
    )
    const back = yield* walk(
      connection,
      built.page,
      controls.revinclude,
      false,
      limits,
      seen
    )
    const entry: ReadonlyArray<Entry> = [
      ...matches.map((one) => ({
        mode: "match" as const,
        resource: JSON.parse(one.body) as FhirResource
      })),
      ...[...forward, ...back].map((one) => ({
        mode: "include" as const,
        resource: JSON.parse(one.body) as FhirResource
      }))
    ]
    return { total, entry }
  })
