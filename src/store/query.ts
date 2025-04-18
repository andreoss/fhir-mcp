import { Effect, Either } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Include, Sort } from "../search/control.js"
import type { Query } from "../search/parse.js"
import { paramsOf } from "../search/registry.js"
import { fold } from "../search/tree.js"
import type {
  Compare,
  DateValue,
  Expr,
  Missing,
  Prefix,
  ValueType,
  Visitor
} from "../search/tree.js"

export interface Frag {
  readonly sql: string
  readonly values: ReadonlyArray<unknown>
}

export interface Plan {
  readonly count: Frag
  readonly page: Frag
}

export interface Paging {
  readonly offset?: number
  readonly limit?: number
}

export interface Entry {
  readonly mode: "match" | "include"
  readonly resource: FhirResource
}

export interface Result {
  readonly total: number | undefined
  readonly entry: ReadonlyArray<Entry>
}

export type IndexEntry =
  | {
      readonly kind: "token"
      readonly name: string
      readonly system: string | undefined
      readonly code: string | undefined
      readonly text: string | undefined
    }
  | { readonly kind: "number"; readonly name: string; readonly value: number }
  | {
      readonly kind: "date"
      readonly name: string
      readonly low: string
      readonly high: string
    }
  | {
      readonly kind: "quantity"
      readonly name: string
      readonly value: number
      readonly system: string | undefined
      readonly code: string | undefined
    }
  | {
      readonly kind: "reference"
      readonly name: string
      readonly targetType: string | undefined
      readonly targetId: string | undefined
      readonly url: string | undefined
      readonly idSystem: string | undefined
      readonly idCode: string | undefined
    }

export const INDEX_SQL: ReadonlyArray<string> = [
  `create table if not exists index_token (
     surrogate_id bigint not null, resource_type varchar not null,
     name varchar not null, system varchar, code varchar, text varchar
   )`,
  `create table if not exists index_number (
     surrogate_id bigint not null, resource_type varchar not null,
     name varchar not null, value double not null
   )`,
  `create table if not exists index_date (
     surrogate_id bigint not null, resource_type varchar not null,
     name varchar not null, low timestamp not null, high timestamp not null
   )`,
  `create table if not exists index_quantity (
     surrogate_id bigint not null, resource_type varchar not null,
     name varchar not null, value double not null, system varchar, code varchar
   )`,
  `create table if not exists index_reference (
     surrogate_id bigint not null, resource_type varchar not null,
     name varchar not null, target_type varchar, target_id varchar,
     url varchar, id_system varchar, id_code varchar
   )`,
  `create index if not exists index_token_lookup
     on index_token (resource_type, name, code)`,
  `create index if not exists index_number_lookup
     on index_number (resource_type, name, value)`,
  `create index if not exists index_date_lookup
     on index_date (resource_type, name, low)`,
  `create index if not exists index_quantity_lookup
     on index_quantity (resource_type, name, value)`,
  `create index if not exists index_reference_lookup
     on index_reference (resource_type, name, target_id)`
]

const TABLE: Record<ValueType, string> = {
  string: "resource_index",
  uri: "resource_index",
  composite: "resource_index",
  token: "index_token",
  number: "index_number",
  date: "index_date",
  quantity: "index_quantity",
  reference: "index_reference"
}

const SORTED: Partial<Record<ValueType, string>> = {
  string: "value",
  uri: "value",
  token: "code",
  number: "value",
  date: "low",
  quantity: "value",
  reference: "target_id"
}

const ORDER: Partial<Record<Prefix, string>> = {
  eq: "=",
  gt: ">",
  lt: "<",
  ge: ">=",
  le: "<=",
  sa: ">",
  eb: "<"
}

const OWN: ReadonlySet<string> = new Set(["_id", "_type", "_lastUpdated"])

const DAY = 86400000

const frag = (sql: string, values: ReadonlyArray<unknown> = []): Frag => ({ sql, values })

const stamp = (iso: string): string => iso.replace("T", " ").replace("Z", "")

const shifted = (iso: string, ms: number): string =>
  stamp(new Date(Date.parse(iso) + ms).toISOString())

const rowsOf = (
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

export const ensure = (connection: DuckDBConnection): Effect.Effect<void, Failure> =>
  Effect.forEach(INDEX_SQL, (statement) => rowsOf(connection, statement), { discard: true })

const insertion = (
  entry: IndexEntry
): { readonly sql: string; readonly values: ReadonlyArray<unknown> } => {
  switch (entry.kind) {
    case "token":
      return {
        sql: `insert into index_token
                (surrogate_id, resource_type, name, system, code, text)
              values (?, ?, ?, ?, ?, ?)`,
        values: [entry.system ?? null, entry.code ?? null, entry.text ?? null]
      }
    case "number":
      return {
        sql: `insert into index_number (surrogate_id, resource_type, name, value)
              values (?, ?, ?, cast(? as double))`,
        values: [entry.value]
      }
    case "date":
      return {
        sql: `insert into index_date (surrogate_id, resource_type, name, low, high)
              values (?, ?, ?, cast(? as timestamp), cast(? as timestamp))`,
        values: [stamp(entry.low), stamp(entry.high)]
      }
    case "quantity":
      return {
        sql: `insert into index_quantity
                (surrogate_id, resource_type, name, value, system, code)
              values (?, ?, ?, cast(? as double), ?, ?)`,
        values: [entry.value, entry.system ?? null, entry.code ?? null]
      }
    case "reference":
      return {
        sql: `insert into index_reference
                (surrogate_id, resource_type, name, target_type, target_id,
                 url, id_system, id_code)
              values (?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.url ?? null,
          entry.idSystem ?? null,
          entry.idCode ?? null
        ]
      }
  }
}

export const index = (
  connection: DuckDBConnection,
  surrogate: bigint,
  type: string,
  entries: ReadonlyArray<IndexEntry>
): Effect.Effect<void, Failure> =>
  Effect.forEach(
    entries,
    (entry) => {
      const one = insertion(entry)
      return rowsOf(connection, one.sql, [surrogate, type, entry.name, ...one.values])
    },
    { discard: true }
  )

interface Ctx {
  readonly alias: string
}

type Built = (ctx: Ctx) => Either.Either<Frag, string>

interface Cond {
  readonly sql: string
  readonly values: ReadonlyArray<unknown>
  readonly negate: boolean
}

const numeric = (column: string, prefix: Prefix, value: number): Cond => {
  if (prefix === "ne") {
    return { sql: `${column} = cast(? as double)`, values: [value], negate: true }
  }
  if (prefix === "ap") {
    const pad = Math.abs(value) * 0.1 || 0.1
    return {
      sql: `${column} between cast(? as double) and cast(? as double)`,
      values: [value - pad, value + pad],
      negate: false
    }
  }
  return {
    sql: `${column} ${ORDER[prefix] ?? "="} cast(? as double)`,
    values: [value],
    negate: false
  }
}

const ranged = (low: string, high: string, value: DateValue): Cond => {
  const at = "cast(? as timestamp)"
  const start = stamp(value.start)
  const end = stamp(value.end)
  switch (value.prefix) {
    case "eq":
    case "ne":
      return {
        sql: `${low} >= ${at} and ${high} <= ${at}`,
        values: [start, end],
        negate: value.prefix === "ne"
      }
    case "gt":
      return { sql: `${high} > ${at}`, values: [end], negate: false }
    case "lt":
      return { sql: `${low} < ${at}`, values: [start], negate: false }
    case "ge":
      return { sql: `${high} > ${at}`, values: [start], negate: false }
    case "le":
      return { sql: `${low} < ${at}`, values: [end], negate: false }
    case "sa":
      return { sql: `${low} >= ${at}`, values: [end], negate: false }
    case "eb":
      return { sql: `${high} <= ${at}`, values: [start], negate: false }
    case "ap": {
      const span = Math.max(Date.parse(value.end) - Date.parse(value.start), DAY)
      return {
        sql: `${low} < ${at} and ${high} > ${at}`,
        values: [shifted(value.end, span), shifted(value.start, -span)],
        negate: false
      }
    }
  }
}

const held = (
  table: string,
  alias: string,
  ctx: Ctx,
  node: { readonly type: string; readonly param: string },
  cond: string,
  values: ReadonlyArray<unknown>,
  negate: boolean
): Frag =>
  frag(
    `${negate ? "not exists" : "exists"} (select 1 from ${table} ${alias}` +
      ` where ${alias}.surrogate_id = ${ctx.alias}.surrogate_id` +
      ` and ${alias}.resource_type = ? and ${alias}.name = ?` +
      (cond.length === 0 ? "" : ` and (${cond})`) +
      `)`,
    [node.type, node.param, ...values]
  )

const own = (node: Compare, ctx: Ctx, negate: boolean): Either.Either<Frag, string> => {
  const value = node.value
  if (node.param === "_lastUpdated") {
    if (value.kind !== "date") return Either.left(`${node.param}: expected a date`)
    const cond = ranged(
      `${ctx.alias}.last_updated`,
      `(${ctx.alias}.last_updated + interval 1 millisecond)`,
      value
    )
    return Either.right(
      frag(`${cond.negate !== negate ? "not " : ""}(${cond.sql})`, cond.values)
    )
  }
  if (value.kind !== "token" || value.code === undefined) {
    return Either.left(`${node.param}: expected a plain value`)
  }
  if (!value.anySystem) return Either.left(`${node.param}: takes no system`)
  const column = node.param === "_id" ? "logical_id" : "resource_type"
  return Either.right(
    frag(`${negate ? "not " : ""}(${ctx.alias}.${column} = ?)`, [value.code])
  )
}

const compared = (node: Compare, ctx: Ctx, alias: string): Either.Either<Frag, string> => {
  const negate = node.modifier === "not" || node.modifier === "not-in"
  if (node.modifier === "in" || node.modifier === "not-in") {
    return Either.left(`${node.param}: value set membership is not indexed`)
  }
  if (OWN.has(node.param)) return own(node, ctx, negate)
  const value = node.value
  if (node.modifier === "text") {
    return value.kind === "string"
      ? Either.right(
          held(
            "index_token",
            alias,
            ctx,
            node,
            `contains(lower(${alias}.text), lower(?))`,
            [value.text],
            false
          )
        )
      : Either.left(`${node.param}: expected text`)
  }
  switch (value.kind) {
    case "string": {
      const cond =
        node.modifier === "exact"
          ? `${alias}.value = ?`
          : node.modifier === "contains"
            ? `contains(lower(${alias}.value), lower(?))`
            : `starts_with(lower(${alias}.value), lower(?))`
      return Either.right(
        held("resource_index", alias, ctx, node, cond, [value.text], negate)
      )
    }
    case "uri": {
      const cond =
        node.modifier === "below"
          ? `starts_with(${alias}.value, ?)`
          : node.modifier === "above"
            ? `starts_with(cast(? as varchar), ${alias}.value)`
            : node.modifier === "contains"
              ? `contains(lower(${alias}.value), lower(?))`
              : `${alias}.value = ?`
      return Either.right(
        held("resource_index", alias, ctx, node, cond, [value.value], negate)
      )
    }
    case "token": {
      if (node.modifier === "above" || node.modifier === "below") {
        return Either.left(`${node.param}: subsumption needs a terminology service`)
      }
      const parts: Array<string> = []
      const values: Array<unknown> = []
      if (value.anySystem) {
        if (value.code === undefined) return Either.left(`${node.param}: expected a code`)
        parts.push(`${alias}.code = ?`)
        values.push(value.code)
      } else {
        if (value.system === undefined) parts.push(`${alias}.system is null`)
        else {
          parts.push(`${alias}.system = ?`)
          values.push(value.system)
        }
        if (value.code !== undefined) {
          parts.push(`${alias}.code = ?`)
          values.push(value.code)
        }
      }
      return Either.right(
        held("index_token", alias, ctx, node, parts.join(" and "), values, negate)
      )
    }
    case "number": {
      const cond = numeric(`${alias}.value`, value.prefix, value.value)
      return Either.right(
        held(
          "index_number",
          alias,
          ctx,
          node,
          cond.sql,
          cond.values,
          cond.negate !== negate
        )
      )
    }
    case "date": {
      const cond = ranged(`${alias}.low`, `${alias}.high`, value)
      return Either.right(
        held("index_date", alias, ctx, node, cond.sql, cond.values, cond.negate !== negate)
      )
    }
    case "quantity": {
      const cond = numeric(`${alias}.value`, value.prefix, value.value)
      const parts = [cond.sql]
      const values: Array<unknown> = [...cond.values]
      if (value.system !== undefined) {
        parts.push(`${alias}.system = ?`)
        values.push(value.system)
      }
      if (value.code !== undefined) {
        parts.push(`${alias}.code = ?`)
        values.push(value.code)
      }
      return Either.right(
        held(
          "index_quantity",
          alias,
          ctx,
          node,
          parts.join(" and "),
          values,
          cond.negate !== negate
        )
      )
    }
    case "reference": {
      if (node.modifier === "above" || node.modifier === "below") {
        return Either.left(`${node.param}: hierarchical references are not indexed`)
      }
      const ref = value.ref
      const parts: Array<string> = []
      const values: Array<unknown> = []
      if (ref.form === "id") {
        parts.push(`${alias}.target_id = ?`)
        values.push(ref.id)
        if (node.target !== undefined) {
          parts.push(`${alias}.target_type = ?`)
          values.push(node.target)
        }
      } else if (ref.form === "typed") {
        parts.push(`${alias}.target_type = ?`, `${alias}.target_id = ?`)
        values.push(ref.type, ref.id)
      } else if (ref.form === "url") {
        parts.push(`${alias}.url = ?`)
        values.push(ref.url)
      } else if (ref.anySystem) {
        if (ref.code === undefined) return Either.left(`${node.param}: expected a code`)
        parts.push(`${alias}.id_code = ?`)
        values.push(ref.code)
      } else {
        if (ref.system === undefined) parts.push(`${alias}.id_system is null`)
        else {
          parts.push(`${alias}.id_system = ?`)
          values.push(ref.system)
        }
        if (ref.code !== undefined) {
          parts.push(`${alias}.id_code = ?`)
          values.push(ref.code)
        }
      }
      return Either.right(
        held("index_reference", alias, ctx, node, parts.join(" and "), values, negate)
      )
    }
    case "of-type":
      return Either.left(`${node.param}: of-type needs an identifier type index`)
    case "composite":
      return Either.left(`${node.param}: composite values are not indexed`)
  }
}

const absent = (node: Missing, ctx: Ctx, alias: string): Either.Either<Frag, string> => {
  if (OWN.has(node.param)) return Either.right(frag(node.present ? "true" : "false"))
  const param = paramsOf(node.type)?.[node.param]
  if (param === undefined) {
    return Either.left(`unknown search parameter: ${node.param} on ${node.type}`)
  }
  const table = TABLE[param.valueType]
  return Either.right(held(table, alias, ctx, node, "", [], !node.present))
}

const joined = (
  terms: ReadonlyArray<Either.Either<Frag, string>>,
  operator: string,
  empty: string
): Either.Either<Frag, string> =>
  Either.map(Either.all(terms), (found) =>
    found.length === 0
      ? frag(empty)
      : frag(
          found.map((one) => `(${one.sql})`).join(` ${operator} `),
          found.flatMap((one) => [...one.values])
        )
  )

const visitor = (): Visitor<Built> => {
  let seq = 0
  const tag = (letter: string) => `${letter}${seq++}`
  return {
    and: (terms) => (ctx) => joined(terms.map((term) => term(ctx)), "and", "true"),
    or: (terms) => (ctx) => joined(terms.map((term) => term(ctx)), "or", "false"),
    compare: (node) => (ctx) => compared(node, ctx, tag("v")),
    missing: (node) => (ctx) => absent(node, ctx, tag("v")),
    chain: (next, node) => (ctx) => {
      const link = tag("x")
      const far = tag("c")
      return Either.map(next({ alias: far }), (inner) =>
        frag(
          `exists (select 1 from index_reference ${link}` +
            ` join resource ${far} on ${far}.logical_id = ${link}.target_id` +
            ` and ${far}.resource_type = ?` +
            ` and ${far}.is_current and not ${far}.deleted` +
            ` where ${link}.surrogate_id = ${ctx.alias}.surrogate_id` +
            ` and ${link}.resource_type = ? and ${link}.name = ?` +
            ` and (${link}.target_type is null or ${link}.target_type = ?)` +
            ` and (${inner.sql}))`,
          [node.target, node.type, node.param, node.target, ...inner.values]
        )
      )
    },
    has: (next, node) => (ctx) => {
      const link = tag("x")
      const from = tag("h")
      return Either.map(next({ alias: from }), (inner) =>
        frag(
          `exists (select 1 from resource ${from}` +
            ` join index_reference ${link}` +
            ` on ${link}.surrogate_id = ${from}.surrogate_id` +
            ` and ${link}.resource_type = ? and ${link}.name = ?` +
            ` where ${from}.resource_type = ?` +
            ` and ${from}.is_current and not ${from}.deleted` +
            ` and ${link}.target_id = ${ctx.alias}.logical_id` +
            ` and (${link}.target_type is null or ${link}.target_type = ?)` +
            ` and (${inner.sql}))`,
          [node.source, node.ref, node.source, node.type, ...inner.values]
        )
      )
    }
  }
}

const lifted = (found: Either.Either<Frag, string>): Effect.Effect<Frag, Failure> =>
  Either.match(found, {
    onLeft: (reason) => Effect.fail<Failure>(new Rejected({ reason })),
    onRight: (one) => Effect.succeed(one)
  })

export const predicate = (expr: Expr, alias: string): Effect.Effect<Frag, Failure> =>
  lifted(fold(expr, visitor())({ alias }))

const restriction = (query: Query, alias: string): Effect.Effect<Frag, Failure> => {
  const base =
    `${alias}.resource_type = ? and ${alias}.is_current and not ${alias}.deleted`
  if (query.expr === undefined) return Effect.succeed(frag(base, [query.type]))
  return Effect.map(predicate(query.expr, alias), (one) =>
    frag(`${base} and (${one.sql})`, [query.type, ...one.values])
  )
}

const key = (type: string, sort: Sort, alias: string): Either.Either<Frag, string> => {
  if (sort.name === "_id") return Either.right(frag(`${alias}.logical_id`))
  if (sort.name === "_lastUpdated") return Either.right(frag(`${alias}.last_updated`))
  if (sort.name === "_type") return Either.right(frag(`${alias}.resource_type`))
  const param = paramsOf(type)?.[sort.name]
  const column = param === undefined ? undefined : SORTED[param.valueType]
  if (param === undefined || column === undefined) {
    return Either.left(`_sort: ${type} cannot be ordered by ${sort.name}`)
  }
  const table = TABLE[param.valueType]
  return Either.right(
    frag(
      `(select min(s.${column}) from ${table} s` +
        ` where s.surrogate_id = ${alias}.surrogate_id` +
        ` and s.resource_type = ? and s.name = ?)`,
      [type, sort.name]
    )
  )
}

const ordering = (query: Query, alias: string): Effect.Effect<Frag, Failure> =>
  Effect.map(
    lifted(
      Either.map(
        Either.all(query.controls.sort.map((sort) => key(query.type, sort, alias))),
        (keys) =>
          frag(
            keys
              .map((one, at) =>
                `${one.sql} ${query.controls.sort[at]?.descending === true ? "desc" : "asc"}` +
                ` nulls last`
              )
              .join(", "),
            keys.flatMap((one) => [...one.values])
          )
      )
    ),
    (one) =>
      frag(
        one.sql.length === 0
          ? `${alias}.surrogate_id asc`
          : `${one.sql}, ${alias}.surrogate_id asc`,
        one.values
      )
  )

const window = (
  limit: number | undefined,
  offset: number
): { readonly sql: string; readonly values: ReadonlyArray<unknown> } =>
  limit === undefined
    ? { sql: ` offset ?`, values: [offset] }
    : { sql: ` limit ? offset ?`, values: [limit, offset] }

export const plan = (query: Query, paging: Paging = {}): Effect.Effect<Plan, Failure> =>
  Effect.gen(function* () {
    const where = yield* restriction(query, "r")
    const order = yield* ordering(query, "r")
    const limit = paging.limit ?? query.controls.count
    const cut = window(limit, paging.offset ?? 0)
    return {
      count: frag(`select count(*) as total from resource r where ${where.sql}`, where.values),
      page: frag(
        `select r.surrogate_id as surrogate_id, r.resource_type as resource_type,` +
          ` r.logical_id as logical_id, r.body as body from resource r` +
          ` where ${where.sql} order by ${order.sql}${cut.sql}`,
        [...where.values, ...order.values, ...cut.values]
      )
    }
  })

const driver = (page: Frag): Frag =>
  frag(
    `(select surrogate_id, resource_type, logical_id from (${page.sql}) d)`,
    page.values
  )

interface Reached {
  readonly surrogate: unknown
  readonly type: string
  readonly id: string
  readonly body: string
}

const seeds = (list: ReadonlyArray<Reached>): Frag =>
  frag(
    `(${list
      .map(
        () =>
          `select cast(? as bigint) as surrogate_id, cast(? as varchar) as resource_type,` +
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

const step = (source: Frag, list: ReadonlyArray<Include>, forward: boolean): Frag => {
  const match = wanted(list, "x")
  const body = forward
    ? `select distinct t.surrogate_id as surrogate_id,` +
      ` t.resource_type as resource_type, t.logical_id as logical_id,` +
      ` t.body as body from page p` +
      ` join index_reference x on x.surrogate_id = p.surrogate_id` +
      ` join resource t on t.resource_type = x.target_type` +
      ` and t.logical_id = x.target_id` +
      ` where t.is_current and not t.deleted and (${match.sql})`
    : `select distinct t.surrogate_id as surrogate_id,` +
      ` t.resource_type as resource_type, t.logical_id as logical_id,` +
      ` t.body as body from page p` +
      ` join index_reference x on x.target_type = p.resource_type` +
      ` and x.target_id = p.logical_id` +
      ` join resource t on t.surrogate_id = x.surrogate_id` +
      ` where t.is_current and not t.deleted and (${match.sql})`
  return frag(`with page as ${source.sql} ${body}`, [...source.values, ...match.values])
}

const ROUNDS = 3

const reached = (row: Record<string, unknown>): Reached => ({
  surrogate: row["surrogate_id"],
  type: String(row["resource_type"]),
  id: String(row["logical_id"]),
  body: String(row["body"])
})

const walk = (
  connection: DuckDBConnection,
  page: Frag,
  list: ReadonlyArray<Include>,
  forward: boolean,
  seen: Set<string>
): Effect.Effect<ReadonlyArray<Reached>, Failure> =>
  Effect.gen(function* () {
    if (list.length === 0) return []
    const iterating = list.filter((one) => one.iterate)
    const out: Array<Reached> = []
    let source = driver(page)
    let current = list
    for (let round = 0; round < ROUNDS; round++) {
      const built = step(source, current, forward)
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

export const execute = (
  connection: DuckDBConnection,
  query: Query,
  paging: Paging = {}
): Effect.Effect<Result, Failure> =>
  Effect.gen(function* () {
    const built = yield* plan(query, paging)
    const counted =
      query.controls.total === "none"
        ? undefined
        : yield* Effect.map(rowsOf(connection, built.count.sql, built.count.values), (rows) =>
            Number(rows[0]?.["total"] ?? 0)
          )
    const rows = yield* rowsOf(connection, built.page.sql, built.page.values)
    const matches = rows.map(reached)
    const seen = new Set(matches.map((one) => `${one.type}/${one.id}`))
    const forward = yield* walk(connection, built.page, query.controls.include, true, seen)
    const back = yield* walk(connection, built.page, query.controls.revinclude, false, seen)
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
    return { total: counted, entry }
  })
