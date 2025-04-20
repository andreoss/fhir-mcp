import { Effect } from "effect"
import type { FhirResource } from "../core/engine.js"
import {
  Rules,
  Versions,
  conditionalCreate,
  conditionalPatch,
  conditionalRemove,
  conditionalUpdate,
  create,
  patch,
  read,
  remove,
  update
} from "../core/interactions.js"
import type { Criteria, Version, Written } from "../core/interactions.js"
import { Forbidden, Rejected, statusOf, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { Unit } from "./unit.js"

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

export interface Request {
  readonly method: Method
  readonly url: string
  readonly ifNoneExist?: string
  readonly ifMatch?: string
}

export interface Entry {
  readonly fullUrl?: string
  readonly resource?: unknown
  readonly request: Request
}

export interface Bundle {
  readonly resourceType: "Bundle"
  readonly type: "transaction" | "batch"
  readonly entry?: ReadonlyArray<Entry>
}

export interface Reply {
  readonly status: string
  readonly location?: string
  readonly etag?: string
  readonly lastModified?: string
  readonly outcome?: OperationOutcome
}

export interface Result {
  readonly fullUrl?: string
  readonly resource?: FhirResource
  readonly response: Reply
}

export interface Answer {
  readonly resourceType: "Bundle"
  readonly type: "transaction-response" | "batch-response"
  readonly entry: ReadonlyArray<Result>
}

export interface Grant {
  readonly read: boolean
  readonly write: boolean
  readonly types: ReadonlyArray<string>
}

export const full: Grant = { read: true, write: true, types: [] }

const TYPE = /^[A-Z][A-Za-z]{1,63}$/

const RANK: Record<Method, number> = { DELETE: 0, POST: 1, PUT: 2, PATCH: 2, GET: 3 }

const NONE: ReadonlyMap<string, string> = new Map()

interface Target {
  readonly type: string
  readonly id?: string
  readonly criteria: Criteria
}

interface Placed {
  readonly entry: Entry
  readonly index: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const criteriaOf = (query: string): Criteria =>
  query
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const cut = pair.indexOf("=")
      const name = cut < 0 ? pair : pair.slice(0, cut)
      const value = cut < 0 ? "" : pair.slice(cut + 1)
      return [decodeURIComponent(name), decodeURIComponent(value)] as const
    })

const targetOf = (url: string): Target | undefined => {
  const cut = url.indexOf("?")
  const path = cut < 0 ? url : url.slice(0, cut)
  const query = cut < 0 ? "" : url.slice(cut + 1)
  const parts = path.split("/").filter((part) => part.length > 0)
  const type = parts[0]
  if (type === undefined || !TYPE.test(type) || parts.length > 2) return undefined
  const id = parts[1]
  return { type, ...(id === undefined ? {} : { id }), criteria: criteriaOf(query) }
}

const permitted = (
  grant: Grant,
  target: Target,
  method: Method
): Effect.Effect<void, Failure> => {
  const action = `${method} ${target.type}`
  const may = method === "GET" ? grant.read : grant.write
  if (!may) return Effect.fail(new Forbidden({ action }))
  if (grant.types.length > 0 && !grant.types.includes(target.type)) {
    return Effect.fail(new Forbidden({ action }))
  }
  return Effect.void
}

const swapped = (value: unknown, links: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return links.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => swapped(item, links))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, held] of Object.entries(value)) out[key] = swapped(held, links)
    return out
  }
  return value
}

const bodyOf = (url: string, given: unknown): Effect.Effect<FhirResource, Failure> =>
  isRecord(given) && typeof given["resourceType"] === "string"
    ? Effect.succeed(given as FhirResource)
    : Effect.fail(new Rejected({ reason: `${url} carries no resource to write` }))

const targeted = (target: Target): Effect.Effect<string, Failure> =>
  target.id === undefined
    ? Effect.fail(new Rejected({ reason: `${target.type} needs an id or criteria` }))
    : Effect.succeed(target.id)

const stampOf = (resource: FhirResource): string | undefined => {
  const meta = resource["meta"]
  if (!isRecord(meta)) return undefined
  const when = meta["lastUpdated"]
  return typeof when === "string" ? when : undefined
}

const wrote = (done: Written): Result => {
  const when = stampOf(done.resource)
  return {
    resource: done.resource,
    response: {
      status: done.created ? "201" : "200",
      location: done.location,
      etag: done.etag,
      ...(when === undefined ? {} : { lastModified: when })
    }
  }
}

const erased: Result = { response: { status: "204" } }

const searched = (held: ReadonlyArray<Version>): Result => ({
  resource: {
    resourceType: "Bundle",
    type: "searchset",
    total: held.length,
    entry: held.map((one) => ({ fullUrl: `${one.type}/${one.id}`, resource: one.body }))
  },
  response: { status: "200" }
})

const answered = (
  type: "transaction-response" | "batch-response",
  entry: ReadonlyArray<Result>
): Answer => ({ resourceType: "Bundle", type, entry })

const excused = (entry: Entry, failure: Failure): Result => ({
  ...(entry.fullUrl === undefined ? {} : { fullUrl: entry.fullUrl }),
  response: { status: String(statusOf(failure)), outcome: toOutcome(failure) }
})

const acted = (
  entry: Entry,
  target: Target,
  body: unknown,
  assigned: string | undefined
): Effect.Effect<Result, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const request = entry.request
    if (request.method === "GET") {
      if (target.id !== undefined) {
        const found = yield* read(target.type, target.id)
        return { resource: found, response: { status: "200" } }
      }
      const store = yield* Versions
      return searched(yield* store.matching(target.type, target.criteria))
    }
    if (request.method === "DELETE") {
      if (target.criteria.length > 0) yield* conditionalRemove(target.type, target.criteria)
      else yield* remove(target.type, yield* targeted(target))
      return erased
    }
    if (request.method === "PATCH") {
      if (target.criteria.length > 0) {
        return wrote(
          yield* conditionalPatch(target.type, target.criteria, body, request.ifMatch)
        )
      }
      const id = yield* targeted(target)
      return wrote(yield* patch(target.type, id, body, request.ifMatch))
    }
    const given = yield* bodyOf(request.url, body)
    if (request.method === "POST") {
      const where = request.ifNoneExist === undefined ? [] : criteriaOf(request.ifNoneExist)
      if (where.length > 0) {
        const meant = assigned === undefined ? given : { ...given, id: assigned }
        return wrote(yield* conditionalCreate(target.type, meant, where))
      }
      return wrote(yield* create(target.type, given, assigned ?? target.id))
    }
    if (target.criteria.length > 0) {
      return wrote(
        yield* conditionalUpdate(target.type, given, target.criteria, request.ifMatch)
      )
    }
    const id = yield* targeted(target)
    return wrote(yield* update(target.type, id, given, request.ifMatch))
  })

const one = (
  entry: Entry,
  grant: Grant,
  links: ReadonlyMap<string, string>
): Effect.Effect<Result, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const target = targetOf(entry.request.url)
    if (target === undefined) {
      return yield* Effect.fail(
        new Rejected({ reason: `entry url is not an interaction: ${entry.request.url}` })
      )
    }
    yield* permitted(grant, target, entry.request.method)
    const from = entry.fullUrl
    const known = from === undefined ? undefined : links.get(from)
    const result = yield* acted(
      entry,
      target,
      swapped(entry.resource, links),
      known?.split("/")[1]
    )
    return from === undefined ? result : { fullUrl: from, ...result }
  })

const foretell = (
  entries: ReadonlyArray<Entry>
): Effect.Effect<Map<string, string>, Failure, Versions> =>
  Effect.gen(function* () {
    const store = yield* Versions
    const links = new Map<string, string>()
    for (const entry of entries) {
      const from = entry.fullUrl
      if (from === undefined || entry.request.method !== "POST") continue
      const target = targetOf(entry.request.url)
      if (target === undefined) continue
      const held = isRecord(entry.resource) ? entry.resource["id"] : undefined
      const id = typeof held === "string" ? held : yield* store.mint(target.type)
      links.set(from, `${target.type}/${id}`)
    }
    return links
  })

const remember = (links: Map<string, string>, entry: Entry, result: Result): void => {
  const from = entry.fullUrl
  const made = result.resource
  if (from === undefined || made === undefined || made.id === undefined) return
  links.set(from, `${made.resourceType}/${made.id}`)
}

const ordered = (entries: ReadonlyArray<Entry>): ReadonlyArray<Placed> =>
  entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        RANK[a.entry.request.method] - RANK[b.entry.request.method] || a.index - b.index
    )

const strict = (
  entries: ReadonlyArray<Entry>,
  grant: Grant
): Effect.Effect<ReadonlyArray<Result>, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const links = yield* foretell(entries)
    const done = yield* Effect.forEach(
      ordered(entries),
      (held) =>
        one(held.entry, grant, links).pipe(
          Effect.tap((result) => Effect.sync(() => remember(links, held.entry, result))),
          Effect.map((result) => ({ index: held.index, result }))
        ),
      { concurrency: 1 }
    )
    return [...done].sort((a, b) => a.index - b.index).map((held) => held.result)
  })

const tolerant = (
  entry: Entry,
  grant: Grant
): Effect.Effect<Result, never, Versions | Rules> =>
  one(entry, grant, NONE).pipe(
    Effect.catchAll((failure) => Effect.succeed(excused(entry, failure)))
  )

export const apply = (
  bundle: Bundle,
  grant: Grant,
  width = 4
): Effect.Effect<Answer, Failure, Versions | Rules | Unit> =>
  Effect.gen(function* () {
    if (!Number.isInteger(width) || width < 1) {
      return yield* Effect.fail(
        new Rejected({ reason: `bundle concurrency is not a bound: ${width}` })
      )
    }
    const entries = bundle.entry ?? []
    const unit = yield* Unit
    if (bundle.type === "batch") {
      return answered(
        "batch-response",
        yield* Effect.forEach(entries, (entry) => tolerant(entry, grant), {
          concurrency: Math.min(width, unit.lanes)
        })
      )
    }
    return answered("transaction-response", yield* unit.within(strict(entries, grant)))
  })
