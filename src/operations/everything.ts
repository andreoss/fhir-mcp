import { Effect } from "effect"
import { Gone, NotFound, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { TYPES, inCompartment } from "./compartment.js"
import { allow, covers, reaches } from "./grant.js"
import type { Grant } from "./grant.js"
import { ID, at, lower, pageOf, sized, upper } from "./page.js"
import type { Page, Params } from "./page.js"
import { Records } from "./records.js"
import type { Window } from "./records.js"

export interface Everything {
  readonly patient: string
  readonly since?: string
  readonly till?: string
  readonly types?: ReadonlyArray<string>
  readonly count?: number
  readonly ct?: string
}

const OP = "$everything"

const shape = (request: Everything, limit: number): Params => {
  const out: Array<readonly [string, string]> = [
    ["_patient", request.patient],
    ["_count", String(limit)]
  ]
  if (request.since !== undefined) out.push(["_since", request.since])
  if (request.till !== undefined) out.push(["_till", request.till])
  if (request.types !== undefined) out.push(["_type", [...request.types].join(",")])
  return out
}

const wanted = (
  request: Everything,
  grant: Grant
): Effect.Effect<ReadonlyArray<string>, Failure> =>
  Effect.gen(function* () {
    const asked = request.types
    if (asked === undefined) return TYPES.filter((type) => covers(grant, type))
    for (const type of asked) {
      if (!inCompartment(type)) {
        return yield* Effect.fail(
          new Rejected({ reason: `${type} is not in the patient compartment` })
        )
      }
      yield* allow(covers(grant, type), `${OP} of ${type}`)
    }
    return asked
  })

const window = (request: Everything): Effect.Effect<Window, Failure> =>
  Effect.gen(function* () {
    const since = request.since === undefined ? undefined : yield* lower("_since", request.since)
    const till = request.till === undefined ? undefined : yield* upper("_till", request.till)
    return {
      ...(since === undefined ? {} : { since }),
      ...(till === undefined ? {} : { till })
    }
  })

export const everything = (
  request: Everything,
  grant: Grant
): Effect.Effect<Page, Failure, Records> =>
  Effect.gen(function* () {
    if (!ID.test(request.patient)) {
      return yield* Effect.fail(
        new Rejected({ reason: `${request.patient} is not a resource id` })
      )
    }
    yield* allow(grant.read, OP)
    yield* allow(reaches(grant, request.patient), `${OP} of Patient/${request.patient}`)
    const types = yield* wanted(request, grant)
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
    const page = yield* records.compartment(request.patient, types, held, slice)
    return pageOf(OP, `Patient/${request.patient}/${OP}`, params, slice, page.total, page.of)
  })
