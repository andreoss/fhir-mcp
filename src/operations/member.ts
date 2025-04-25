import { Effect } from "effect"
import type { FhirResource } from "../core/engine.js"
import type { Version } from "../core/interactions.js"
import { Conflict, NotFound, Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { allow, covers, reaches } from "./grant.js"
import type { Grant } from "./grant.js"
import { Records } from "./records.js"

export interface Identifier {
  readonly system?: string
  readonly value: string
}

export type Answer =
  | { readonly _tag: "Match"; readonly patient: FhirResource; readonly identifier: Identifier }
  | { readonly _tag: "NoMatch"; readonly outcome: OperationOutcome }

const OP = "$member-match"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const identifiersOf = (body: FhirResource): ReadonlyArray<Identifier> => {
  const held = body["identifier"]
  const out: Array<Identifier> = []
  for (const one of Array.isArray(held) ? held : []) {
    if (!isRecord(one)) continue
    const value = one["value"]
    if (typeof value !== "string") continue
    const system = one["system"]
    out.push(typeof system === "string" ? { system, value } : { value })
  }
  return out
}

const label = (identifier: Identifier): string =>
  identifier.system === undefined ? identifier.value : `${identifier.system}|${identifier.value}`

const carries = (candidate: Version, asked: Identifier): Identifier | undefined =>
  identifiersOf(candidate.body).find(
    (one) =>
      one.value === asked.value && (asked.system === undefined || one.system === asked.system)
  )

export const memberMatch = (
  patient: FhirResource,
  grant: Grant
): Effect.Effect<Answer, Failure, Records> =>
  Effect.gen(function* () {
    yield* allow(grant.read, OP)
    yield* allow(covers(grant, "Patient"), `${OP} of Patient`)
    if (patient.resourceType !== "Patient") {
      return yield* Effect.fail(
        new Rejected({ reason: `${OP} takes a Patient, not ${patient.resourceType}` })
      )
    }
    const asked = identifiersOf(patient)
    if (asked.length === 0) {
      return yield* Effect.fail(
        new Rejected({ reason: `${OP} needs an identifier on the patient` })
      )
    }
    const records = yield* Records
    const hits = new Map<string, Answer>()
    for (const one of asked) {
      const candidates = yield* records.byIdentifier("Patient", one.value)
      for (const candidate of candidates) {
        if (!reaches(grant, candidate.id)) continue
        const held = carries(candidate, one)
        if (held === undefined) continue
        hits.set(candidate.id, { _tag: "Match", patient: candidate.body, identifier: held })
      }
    }
    if (hits.size > 1) {
      return yield* Effect.fail(
        new Conflict({ reason: `${hits.size} patients carry the identifiers given` })
      )
    }
    const only = [...hits.values()][0]
    if (only !== undefined) return only
    const none: Answer = {
      _tag: "NoMatch",
      outcome: toOutcome(
        new NotFound({ type: "Patient", id: asked.map(label).join(", ") })
      )
    }
    return none
  })
