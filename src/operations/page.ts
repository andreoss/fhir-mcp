import { Effect } from "effect"
import type { BundleEntry } from "../core/engine.js"
import type { Version } from "../core/interactions.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { issue, redeem } from "../agent/cursor.js"

export type Params = ReadonlyArray<readonly [string, string]>

export interface Slice {
  readonly offset: number
  readonly limit: number
}

export interface Link {
  readonly relation: string
  readonly url: string
}

export interface Page {
  readonly resourceType: "Bundle"
  readonly type: "searchset"
  readonly total: number
  readonly link: ReadonlyArray<Link>
  readonly entry: ReadonlyArray<BundleEntry>
}

export const PAGE = 25

export const MOST = 500

export const ID = /^[A-Za-z0-9\-.]{1,64}$/

const DAY = /^\d{4}-\d{2}-\d{2}$/

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

const bound = (name: string, value: string, rest: string): Effect.Effect<string, Failure> => {
  if (DAY.test(value)) return Effect.succeed(`${value}${rest}`)
  if (INSTANT.test(value)) return Effect.succeed(new Date(Date.parse(value)).toISOString())
  return Effect.fail(new Rejected({ reason: `${name} is not a date: ${value}` }))
}

export const lower = (name: string, value: string): Effect.Effect<string, Failure> =>
  bound(name, value, "T00:00:00.000Z")

export const upper = (name: string, value: string): Effect.Effect<string, Failure> =>
  bound(name, value, "T23:59:59.999Z")

export const sized = (count: number | undefined): Effect.Effect<number, Failure> => {
  if (count === undefined) return Effect.succeed(PAGE)
  return Number.isInteger(count) && count >= 1 && count <= MOST
    ? Effect.succeed(count)
    : Effect.fail(new Rejected({ reason: `_count is not a page size: ${count}` }))
}

export const at = (
  op: string,
  params: Params,
  ct: string | undefined,
  limit: number
): Effect.Effect<Slice, Failure> => {
  if (ct === undefined) return Effect.succeed({ offset: 0, limit })
  const held = redeem(ct, op, params)
  return held === undefined
    ? Effect.fail(new Rejected({ reason: "continuation token not accepted" }))
    : Effect.succeed({ offset: held.offset, limit })
}

export const cut = <A>(list: ReadonlyArray<A>, slice: Slice): ReadonlyArray<A> =>
  list.slice(slice.offset, slice.offset + slice.limit)

const asked = (params: Params, ct: string | undefined): string => {
  const search = new URLSearchParams()
  for (const [name, value] of params) search.append(name, value)
  if (ct !== undefined) search.append("_ct", ct)
  return search.toString()
}

export const pageOf = (
  op: string,
  base: string,
  params: Params,
  slice: Slice,
  total: number,
  found: ReadonlyArray<Version>
): Page => {
  const next = slice.offset + found.length
  const link: Array<Link> = [{ relation: "self", url: `${base}?${asked(params, undefined)}` }]
  if (next < total) {
    link.push({
      relation: "next",
      url: `${base}?${asked(params, issue({ type: op, parameters: params, offset: next }))}`
    })
  }
  return {
    resourceType: "Bundle",
    type: "searchset",
    total,
    link,
    entry: found.map((one) => ({ fullUrl: `${one.type}/${one.id}`, resource: one.body }))
  }
}
