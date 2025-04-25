import { Effect } from "effect"
import type { Version } from "../core/interactions.js"
import { NotFound, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { allow, covers } from "./grant.js"
import type { Grant } from "./grant.js"
import { ID, at, cut, pageOf, sized } from "./page.js"
import type { Page, Params } from "./page.js"
import { Records } from "./records.js"

export interface Named {
  readonly type: string
  readonly id: string
}

export interface Includes {
  readonly of: ReadonlyArray<Named>
  readonly types?: ReadonlyArray<string>
  readonly count?: number
  readonly ct?: string
}

const OP = "$includes"

const TYPE = /^[A-Z][A-Za-z]{1,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const links = (value: unknown, out: Array<Named>): void => {
  if (Array.isArray(value)) {
    for (const item of value) links(item, out)
    return
  }
  if (!isRecord(value)) return
  const held = value["reference"]
  if (typeof held === "string") {
    const parts = held.split("/")
    const type = parts[0]
    const id = parts[1]
    if (type !== undefined && id !== undefined && TYPE.test(type) && ID.test(id)) {
      out.push({ type, id })
    }
  }
  for (const item of Object.values(value)) links(item, out)
}

const shape = (request: Includes, limit: number): Params => {
  const out: Array<readonly [string, string]> = [
    ["_of", request.of.map((one) => `${one.type}/${one.id}`).sort().join(",")],
    ["_count", String(limit)]
  ]
  if (request.types !== undefined) out.push(["_type", [...request.types].join(",")])
  return out
}

export const includes = (
  request: Includes,
  grant: Grant
): Effect.Effect<Page, Failure, Records> =>
  Effect.gen(function* () {
    yield* allow(grant.read, OP)
    if (request.of.length === 0) {
      return yield* Effect.fail(
        new Rejected({ reason: `${OP} needs a resource to start from` })
      )
    }
    for (const one of request.of) {
      if (!TYPE.test(one.type) || !ID.test(one.id)) {
        return yield* Effect.fail(
          new Rejected({ reason: `${one.type}/${one.id} is not a resource` })
        )
      }
      yield* allow(covers(grant, one.type), `${OP} of ${one.type}`)
    }
    const narrowed = request.types
    if (narrowed !== undefined) {
      for (const type of narrowed) yield* allow(covers(grant, type), `${OP} of ${type}`)
    }
    const limit = yield* sized(request.count)
    const params = shape(request, limit)
    const slice = yield* at(OP, params, request.ct, limit)
    const records = yield* Records
    const seeds = new Set(request.of.map((one) => `${one.type}/${one.id}`))
    const wanted = new Map<string, Named>()
    for (const one of request.of) {
      const held = yield* records.get(one.type, one.id)
      if (held === undefined || held.deleted) {
        return yield* Effect.fail(new NotFound({ type: one.type, id: one.id }))
      }
      const out: Array<Named> = []
      links(held.body, out)
      for (const link of out) {
        const key = `${link.type}/${link.id}`
        if (seeds.has(key) || wanted.has(key)) continue
        if (!covers(grant, link.type)) continue
        if (narrowed !== undefined && !narrowed.includes(link.type)) continue
        wanted.set(key, link)
      }
    }
    const found: Array<Version> = []
    for (const key of [...wanted.keys()].sort()) {
      const one = wanted.get(key)
      if (one === undefined) continue
      const held = yield* records.get(one.type, one.id)
      if (held === undefined || held.deleted) continue
      found.push(held)
    }
    return pageOf(OP, OP, params, slice, found.length, cut(found, slice))
  })
