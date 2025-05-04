import { Effect, Either } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { el } from "../model/shape.js"
import type { Definition, Elements } from "../model/shape.js"
import { DEFINITIONS as ELEMENTS } from "../model/resources.js"
import { COMMON, DEFINITIONS as PARAMS } from "../store/definitions.js"
import type { TypeDefinition } from "../store/definitions.js"
import { BUILT_IN } from "../compartment/definition.js"
import type { Definition as Compartment } from "../compartment/definition.js"
import { emit } from "./generate.js"
import type { Models } from "./generate.js"
import { SOURCE } from "./source.js"
import { model } from "./version.js"
import type { VersionModel } from "./version.js"

const withCommon = (
  all: Readonly<Record<string, TypeDefinition>>
): Record<string, TypeDefinition> =>
  Object.fromEntries(
    Object.entries(all).map(([type, held]) => [type, { ...COMMON, ...held }])
  )

const drop = (
  all: Readonly<Record<string, Definition>>,
  name: string
): Record<string, Definition> =>
  Object.fromEntries(Object.entries(all).filter(([key]) => key !== name))

const extend = (
  all: Readonly<Record<string, Definition>>,
  type: string,
  extra: Elements
): Record<string, Definition> =>
  Object.fromEntries(
    Object.entries(all).map(([key, held]) =>
      key === type
        ? [key, { type: held.type, elements: { ...held.elements, ...extra } }]
        : [key, held]
    )
  )

export const GENERATED: Either.Either<Models, string> = emit(SOURCE)

export const modelsOf = (made: Either.Either<Models, string>): Models =>
  Either.getOrElse(made, (): Models => ({}))

const EMITTED: Models = modelsOf(GENERATED)

export const FOUR: VersionModel = model({
  name: "4.0.1",
  elements: ELEMENTS,
  params: withCommon(PARAMS),
  compartments: BUILT_IN
})

const LATER_PARAMS: Readonly<Record<string, TypeDefinition>> = {
  Patient: {
    family: { path: ["name", "family"] },
    given: { path: ["name", "given"] },
    birthdate: { path: ["birthDate"] },
    identifier: { path: ["identifier", "value"] },
    gender: { path: ["gender"] }
  },
  Observation: {
    status: { path: ["status"] },
    code: { path: ["code", "coding", "code"] },
    subject: { path: ["subject", "reference"] }
  },
  Condition: {
    "clinical-status": { path: ["clinicalStatus", "coding", "code"] },
    code: { path: ["code", "coding", "code"] },
    subject: { path: ["subject", "reference"] }
  },
  Procedure: {
    status: { path: ["status"] },
    code: { path: ["code", "coding", "code"] },
    subject: { path: ["subject", "reference"] }
  }
}

const LATER_PATIENT: Compartment = {
  code: "patient",
  resource: "Patient",
  types: {
    Patient: { own: true, params: [] },
    Observation: { own: false, params: ["subject", "performer"] },
    Condition: { own: false, params: ["patient", "subject", "asserter"] },
    Procedure: { own: false, params: ["subject", "performer"] }
  }
}

export const FIVE: VersionModel = model({
  name: "5.0.0",
  elements: {
    ...extend(drop(ELEMENTS, "Encounter"), "Observation", {
      instantiatesCanonical: el("uri")
    }),
    ...EMITTED
  },
  params: withCommon(LATER_PARAMS),
  compartments: [LATER_PATIENT]
})

export const VERSIONS: ReadonlyArray<VersionModel> = [FOUR, FIVE]

export const names = (
  all: ReadonlyArray<VersionModel> = VERSIONS
): ReadonlyArray<string> => all.map((one) => one.name)

export const versionOf = (
  name: string,
  all: ReadonlyArray<VersionModel> = VERSIONS
): Effect.Effect<VersionModel, Failure> => {
  const held = all.find((one) => one.name === name)
  return held === undefined
    ? Effect.fail(new Rejected({ reason: `${name} is not a served version` }))
    : Effect.succeed(held)
}
