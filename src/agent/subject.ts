import { Context, Effect, Option } from "effect"
import type { Action, Kind } from "../auth/scope.js"
import { PATIENT } from "../compartment/definition.js"
import type { Definition } from "../compartment/definition.js"
import type { Limit } from "../compartment/filter.js"

export interface Subject {
  readonly id: string
  readonly kind: Kind
}

export class CurrentSubject extends Context.Tag("AgentSubject")<CurrentSubject, Subject>() {}

export const ANONYMOUS: Subject = { id: "anonymous", kind: "user" }

export const known: Effect.Effect<Subject> = Effect.map(
  Effect.serviceOption(CurrentSubject),
  Option.match({ onNone: () => ANONYMOUS, onSome: (found: Subject) => found })
)

export const named = (subject: Subject): string => `${subject.kind}:${subject.id}`

export const compartmentOf = (subject: Subject): string | undefined =>
  subject.kind === "patient" ? subject.id : undefined

export const scopeOf = (subject: Subject, type: string, action: Action): string => {
  const compartment = compartmentOf(subject)
  return compartment === undefined
    ? `${subject.kind}/${type}.${action}`
    : `${subject.kind}:${compartment}/${type}.${action}`
}

export const limitsOf = (
  subject: Subject,
  definition: Definition = PATIENT
): ReadonlyArray<Limit> =>
  compartmentOf(subject) === undefined ? [] : [{ definition, ids: [subject.id] }]
