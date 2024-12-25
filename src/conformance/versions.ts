import { Effect } from "effect"
import { NotFound } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { PINNED_REVISION } from "../protocol/revision.js"
import { parametersOf, types } from "../store/definitions.js"
import type { TypeDefinition } from "../store/definitions.js"

export interface Registry {
  readonly fhirVersion: string
  readonly types: () => ReadonlyArray<string>
  readonly parametersOf: (type: string) => TypeDefinition | undefined
}

export const REGISTRIES: ReadonlyArray<Registry> = [
  { fhirVersion: "4.0.1", types, parametersOf }
]

export interface Parameter {
  readonly name: "version" | "default" | "protocol"
  readonly valueCode: string
}

export interface Report {
  readonly resourceType: "Parameters"
  readonly parameter: ReadonlyArray<Parameter>
}

export const versions = (registries: ReadonlyArray<Registry> = REGISTRIES): Report => {
  const first = registries[0]
  return {
    resourceType: "Parameters",
    parameter: [
      ...registries.map(
        (registry): Parameter => ({ name: "version", valueCode: registry.fhirVersion })
      ),
      ...(first === undefined
        ? []
        : [{ name: "default", valueCode: first.fhirVersion } as Parameter]),
      { name: "protocol", valueCode: PINNED_REVISION }
    ]
  }
}

export const registryOf = (
  fhirVersion: string,
  registries: ReadonlyArray<Registry> = REGISTRIES
): Effect.Effect<Registry, Failure> => {
  const found = registries.find((registry) => registry.fhirVersion === fhirVersion)
  return found === undefined
    ? Effect.fail(new NotFound({ type: "CapabilityStatement", id: fhirVersion }))
    : Effect.succeed(found)
}
