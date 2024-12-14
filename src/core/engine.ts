import { Context } from "effect"
import type { Effect } from "effect"
import type { Failure } from "./outcome.js"

export interface FhirResource {
  readonly resourceType: string
  readonly id?: string
  readonly [key: string]: unknown
}

export interface BundleEntry {
  readonly fullUrl?: string
  readonly resource: FhirResource
}

export interface Bundle {
  readonly resourceType: "Bundle"
  readonly type: "searchset"
  readonly total?: number
  readonly entry?: ReadonlyArray<BundleEntry>
}

export interface SearchQuery {
  readonly type: string
  readonly parameters: ReadonlyArray<readonly [string, string]>
  readonly offset?: number
  readonly limit?: number
}

export interface Engine {
  readonly read: (type: string, id: string) => Effect.Effect<FhirResource, Failure>
  readonly search: (query: SearchQuery) => Effect.Effect<Bundle, Failure>
  readonly resourceTypes: () => Effect.Effect<ReadonlyArray<string>, Failure>
  readonly searchParameters: (type: string) => Effect.Effect<ReadonlyArray<string>, Failure>
}

export class FhirEngine extends Context.Tag("FhirEngine")<FhirEngine, Engine>() {}
