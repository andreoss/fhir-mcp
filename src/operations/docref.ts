import { Effect } from "effect"
import { Gone, NotFound, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { allow, covers, reaches } from "./grant.js"
import type { Grant } from "./grant.js"
import { ID, at, lower, pageOf, sized, upper } from "./page.js"
import type { Page, Params } from "./page.js"
import { Records } from "./records.js"
import type { Window } from "./records.js"

export interface DocRef {
  readonly patient: string
  readonly start?: string
  readonly end?: string
  readonly count?: number
  readonly ct?: string
}

const OP = "$docref"

const DATE = "$.date"

const NAMES: ReadonlySet<string> = new Set(["patient", "start", "end", "_count", "_ct"])

const VALUES: ReadonlyArray<string> = [
  "valueId",
  "valueString",
  "valueDateTime",
  "valueCode",
  "valueUri",
  "valueInteger"
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const fromQuery = (params: Params): Effect.Effect<DocRef, Failure> =>
  Effect.suspend(() => {
    const held = new Map<string, string>()
    for (const [name, value] of params) {
      if (!NAMES.has(name)) {
        return Effect.fail(new Rejected({ reason: `${OP} does not take ${name}` }))
      }
      if (held.has(name)) {
        return Effect.fail(new Rejected({ reason: `${OP} takes one ${name}` }))
      }
      held.set(name, value)
    }
    const patient = held.get("patient")
    if (patient === undefined) {
      return Effect.fail(new Rejected({ reason: `${OP} needs a patient` }))
    }
    const count = held.get("_count")
    if (count !== undefined && !/^\d+$/.test(count)) {
      return Effect.fail(new Rejected({ reason: `_count is not a page size: ${count}` }))
    }
    const start = held.get("start")
    const end = held.get("end")
    const ct = held.get("_ct")
    return Effect.succeed({
      patient,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...(count === undefined ? {} : { count: Number(count) }),
      ...(ct === undefined ? {} : { ct })
    })
  })

export const fromParameters = (body: unknown): Effect.Effect<DocRef, Failure> =>
  Effect.suspend(() => {
    if (!isRecord(body) || body["resourceType"] !== "Parameters") {
      return Effect.fail(new Rejected({ reason: `${OP} takes a Parameters resource` }))
    }
    const held = body["parameter"]
    if (!Array.isArray(held)) {
      return Effect.fail(new Rejected({ reason: `${OP} takes a parameter list` }))
    }
    const params: Array<readonly [string, string]> = []
    for (const one of held) {
      if (!isRecord(one) || typeof one["name"] !== "string") {
        return Effect.fail(new Rejected({ reason: `${OP} takes named parameters` }))
      }
      const name = one["name"]
      const value = VALUES.map((key) => one[key]).find((held) => held !== undefined)
      if (typeof value !== "string" && typeof value !== "number") {
        return Effect.fail(new Rejected({ reason: `${name} carries no value` }))
      }
      params.push([name, String(value)])
    }
    return fromQuery(params)
  })

const shape = (request: DocRef, limit: number): Params => {
  const out: Array<readonly [string, string]> = [
    ["patient", request.patient],
    ["_count", String(limit)]
  ]
  if (request.start !== undefined) out.push(["start", request.start])
  if (request.end !== undefined) out.push(["end", request.end])
  return out
}

const window = (request: DocRef): Effect.Effect<Window, Failure> =>
  Effect.gen(function* () {
    const since = request.start === undefined ? undefined : yield* lower("start", request.start)
    const till = request.end === undefined ? undefined : yield* upper("end", request.end)
    return {
      on: DATE,
      ...(since === undefined ? {} : { since }),
      ...(till === undefined ? {} : { till })
    }
  })

export const docref = (request: DocRef, grant: Grant): Effect.Effect<Page, Failure, Records> =>
  Effect.gen(function* () {
    if (!ID.test(request.patient)) {
      return yield* Effect.fail(
        new Rejected({ reason: `${request.patient} is not a resource id` })
      )
    }
    yield* allow(grant.read, OP)
    yield* allow(reaches(grant, request.patient), `${OP} of Patient/${request.patient}`)
    yield* allow(covers(grant, "DocumentReference"), `${OP} of DocumentReference`)
    const held = yield* window(request)
    const limit = yield* sized(request.count)
    const params = shape(request, limit)
    const slice = yield* at(OP, params, request.ct, limit)
    const records = yield* Records
    const found = yield* records.get("Patient", request.patient)
    if (found === undefined) {
      return yield* Effect.fail(new NotFound({ type: "Patient", id: request.patient }))
    }
    if (found.deleted) {
      return yield* Effect.fail(new Gone({ type: "Patient", id: request.patient }))
    }
    const page = yield* records.compartment(
      request.patient,
      ["DocumentReference"],
      held,
      slice
    )
    return pageOf(OP, `DocumentReference/${OP}`, params, slice, page.total, page.of)
  })

export const byQuery = (params: Params, grant: Grant): Effect.Effect<Page, Failure, Records> =>
  Effect.flatMap(fromQuery(params), (request) => docref(request, grant))

export const byParameters = (
  body: unknown,
  grant: Grant
): Effect.Effect<Page, Failure, Records> =>
  Effect.flatMap(fromParameters(body), (request) => docref(request, grant))
