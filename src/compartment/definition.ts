import { Effect, Ref } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { isType } from "../search/registry.js"

export interface Membership {
  readonly own: boolean
  readonly params: ReadonlyArray<string>
}

export interface Definition {
  readonly code: string
  readonly resource: string
  readonly types: Readonly<Record<string, Membership>>
}

export interface Manager {
  readonly get: (code: string) => Effect.Effect<Definition, Failure>
  readonly put: (definition: Definition) => Effect.Effect<void, Failure>
  readonly drop: (code: string) => Effect.Effect<void, Failure>
  readonly codes: () => Effect.Effect<ReadonlyArray<string>>
}

export const PATIENT: Definition = {
  code: "patient",
  resource: "Patient",
  types: {
    Patient: { own: true, params: [] },
    Observation: { own: false, params: ["subject", "performer"] },
    Condition: { own: false, params: ["patient", "subject", "asserter"] },
    Encounter: { own: false, params: ["patient", "subject"] }
  }
}

export const ENCOUNTER: Definition = {
  code: "encounter",
  resource: "Encounter",
  types: {
    Encounter: { own: true, params: [] },
    Observation: { own: false, params: ["encounter"] },
    Condition: { own: false, params: ["encounter"] }
  }
}

export const BUILT_IN: ReadonlyArray<Definition> = [PATIENT, ENCOUNTER]

const CODE = /^[a-z][a-z0-9-]{0,63}$/

const refuse = (reason: string): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason }))

export const validate = (
  definition: Definition
): Effect.Effect<Definition, Failure> => {
  if (!CODE.test(definition.code)) {
    return refuse(`compartment code is not a name: ${definition.code}`)
  }
  if (!isType(definition.resource)) {
    return refuse(`unsupported resource type: ${definition.resource}`)
  }
  const anchor = definition.types[definition.resource]
  if (anchor === undefined || !anchor.own) {
    return refuse(`${definition.code}: does not place ${definition.resource}`)
  }
  for (const [type, place] of Object.entries(definition.types)) {
    if (!isType(type)) return refuse(`unsupported resource type: ${type}`)
    if (place.own && type !== definition.resource) {
      return refuse(`${definition.code}: ${type} does not own the compartment`)
    }
    if (!place.own && place.params.length === 0) {
      return refuse(`${definition.code}: ${type} names no parameter`)
    }
  }
  return Effect.succeed(definition)
}

export const manager = (
  seed: ReadonlyArray<Definition> = BUILT_IN
): Effect.Effect<Manager, Failure> =>
  Effect.gen(function* () {
    const checked = yield* Effect.forEach(seed, validate)
    const held = yield* Ref.make<Readonly<Record<string, Definition>>>(
      Object.fromEntries(checked.map((one) => [one.code, one] as const))
    )
    const get = (code: string) =>
      Effect.flatMap(Ref.get(held), (all) => {
        const found = all[code]
        return found === undefined
          ? refuse(`unknown compartment: ${code}`)
          : Effect.succeed(found)
      })
    return {
      get,
      put: (definition) =>
        Effect.flatMap(validate(definition), (checked) =>
          Ref.update(held, (all) => ({ ...all, [checked.code]: checked }))
        ),
      drop: (code) =>
        Effect.flatMap(get(code), () =>
          Ref.update(held, (all) =>
            Object.fromEntries(Object.entries(all).filter(([at]) => at !== code))
          )
        ),
      codes: () => Effect.map(Ref.get(held), (all) => Object.keys(all))
    }
  })
