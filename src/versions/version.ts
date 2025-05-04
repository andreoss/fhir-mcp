import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Definition } from "../model/shape.js"
import type {
  ParameterDefinition,
  TypeDefinition
} from "../store/definitions.js"
import type { Definition as Compartment } from "../compartment/definition.js"

export interface Draft {
  readonly name: string
  readonly elements: Readonly<Record<string, Definition>>
  readonly params: Readonly<Record<string, TypeDefinition>>
  readonly compartments: ReadonlyArray<Compartment>
}

export interface VersionModel extends Draft {
  readonly types: ReadonlyArray<string>
}

export const model = (draft: Draft): VersionModel => ({
  ...draft,
  types: Object.keys(draft.elements).sort()
})

const refuse = <A>(reason: string): Effect.Effect<A, Failure> =>
  Effect.fail(new Rejected({ reason }))

const unserved = <A>(
  version: VersionModel,
  type: string
): Effect.Effect<A, Failure> =>
  refuse(`${type} is not served in ${version.name}`)

export const hasType = (version: VersionModel, type: string): boolean =>
  version.elements[type] !== undefined

export const definitionIn = (
  version: VersionModel,
  type: string
): Effect.Effect<Definition, Failure> => {
  const held = version.elements[type]
  return held === undefined ? unserved(version, type) : Effect.succeed(held)
}

export const paramsIn = (
  version: VersionModel,
  type: string
): Effect.Effect<TypeDefinition, Failure> => {
  const held = version.params[type]
  return held === undefined ? unserved(version, type) : Effect.succeed(held)
}

export const paramIn = (
  version: VersionModel,
  type: string,
  name: string
): Effect.Effect<ParameterDefinition, Failure> =>
  Effect.flatMap(paramsIn(version, type), (all) => {
    const held = all[name]
    return held === undefined
      ? refuse(
        `${name} is not a search parameter of ${type} in ${version.name}`
      )
      : Effect.succeed(held)
  })

export const compartmentIn = (
  version: VersionModel,
  code: string
): Effect.Effect<Compartment, Failure> => {
  const held = version.compartments.find((one) => one.code === code)
  return held === undefined
    ? refuse(`${code} is not a compartment in ${version.name}`)
    : Effect.succeed(held)
}
