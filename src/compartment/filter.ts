import type { Query } from "../search/parse.js"
import { every, some } from "../search/tree.js"
import type { Expr } from "../search/tree.js"
import type { Frag } from "../store/query.js"
import type { Definition } from "./definition.js"

export interface Limit {
  readonly definition: Definition
  readonly ids: ReadonlyArray<string>
}

const nowhere = (type: string): Expr => ({
  kind: "missing",
  type,
  param: "_id",
  present: false
})

const itself = (type: string, id: string): Expr => ({
  kind: "compare",
  type,
  param: "_id",
  valueType: "token",
  modifier: undefined,
  target: undefined,
  value: { kind: "token", system: undefined, code: id, anySystem: true, text: id }
})

const pointing = (
  type: string,
  param: string,
  resource: string,
  id: string
): Expr => ({
  kind: "compare",
  type,
  param,
  valueType: "reference",
  modifier: undefined,
  target: resource,
  value: {
    kind: "reference",
    ref: { form: "typed", type: resource, id },
    text: `${resource}/${id}`
  }
})

export const member = (limit: Limit, type: string): Expr => {
  const place = limit.definition.types[type]
  if (place === undefined) return nowhere(type)
  const terms = place.own
    ? limit.ids.map((id) => itself(type, id))
    : place.params.flatMap((param) =>
        limit.ids.map((id) => pointing(type, param, limit.definition.resource, id))
      )
  return some(terms) ?? nowhere(type)
}

const bounded = (
  expr: Expr,
  type: string,
  limits: ReadonlyArray<Limit>
): Expr => every([...limits.map((limit) => member(limit, type)), expr]) ?? expr

const rewritten = (expr: Expr, limits: ReadonlyArray<Limit>): Expr => {
  switch (expr.kind) {
    case "and":
      return { kind: "and", terms: expr.terms.map((one) => rewritten(one, limits)) }
    case "or":
      return { kind: "or", terms: expr.terms.map((one) => rewritten(one, limits)) }
    case "chain":
      return { ...expr, next: bounded(rewritten(expr.next, limits), expr.target, limits) }
    case "has":
      return { ...expr, next: bounded(rewritten(expr.next, limits), expr.source, limits) }
    default:
      return expr
  }
}

export const restricted = (query: Query, limits: ReadonlyArray<Limit>): Query => {
  if (limits.length === 0) return query
  const inner = query.expr === undefined ? [] : [rewritten(query.expr, limits)]
  return {
    ...query,
    expr: every([...limits.map((limit) => member(limit, query.type)), ...inner])
  }
}

const anyOf = (column: string, count: number): string =>
  Array.from({ length: count }, () => `${column} = ?`).join(" or ")

const placed = (
  limit: Limit,
  type: string,
  alias: string,
  link: string
): Frag | undefined => {
  const place = limit.definition.types[type]
  if (place === undefined || limit.ids.length === 0) return undefined
  if (place.own) {
    return {
      sql:
        `(${alias}.resource_type = ? and` +
        ` (${anyOf(`${alias}.logical_id`, limit.ids.length)}))`,
      values: [type, ...limit.ids]
    }
  }
  return {
    sql:
      `(${alias}.resource_type = ? and exists (select 1 from index_reference ${link}` +
      ` where ${link}.surrogate_id = ${alias}.surrogate_id` +
      ` and ${link}.resource_type = ?` +
      ` and (${anyOf(`${link}.name`, place.params.length)})` +
      ` and ${link}.target_type = ?` +
      ` and (${anyOf(`${link}.target_id`, limit.ids.length)})))`,
    values: [
      type,
      type,
      ...place.params,
      limit.definition.resource,
      ...limit.ids
    ]
  }
}

export const inside = (
  limits: ReadonlyArray<Limit>,
  alias: string,
  prefix: string
): Frag => {
  const parts: Array<string> = []
  const values: Array<unknown> = []
  limits.forEach((limit, at) => {
    const terms = Object.keys(limit.definition.types)
      .map((type) => placed(limit, type, alias, `${prefix}${at}`))
      .filter((one): one is Frag => one !== undefined)
    const joined = terms.map((one) => one.sql).join(" or ")
    parts.push(terms.length === 0 ? "false" : `(${joined})`)
    for (const one of terms) values.push(...one.values)
  })
  return { sql: parts.length === 0 ? "true" : parts.join(" and "), values }
}
