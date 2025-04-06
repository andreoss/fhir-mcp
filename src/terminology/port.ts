import { Context } from "effect"
import type { Effect } from "effect"
import type { Failure } from "../core/outcome.js"
import type { Absence, Designation } from "./system.js"

export interface LookupRequest {
  readonly system: string
  readonly code: string
  readonly version?: string
}

export type Lookup =
  | {
      readonly _tag: "Found"
      readonly system: string
      readonly version: string | undefined
      readonly code: string
      readonly display: string | undefined
      readonly inactive: boolean
      readonly designation: ReadonlyArray<Designation>
    }
  | {
      readonly _tag: "Unsupplied"
      readonly system: string
      readonly content: Absence
      readonly reason: string
    }

export type Subsumption = "equivalent" | "subsumes" | "subsumed-by" | "not-subsumed" | "unknown"

export interface PairRequest {
  readonly system: string
  readonly left: string
  readonly right: string
  readonly version?: string
}

export type Match =
  | { readonly _tag: "Codes"; readonly equal: boolean }
  | { readonly _tag: "Text"; readonly equal: boolean; readonly reason: string }

export interface ExpandRequest {
  readonly url: string
  readonly filter?: string
  readonly count?: number
  readonly offset?: number
  readonly date?: string
  readonly activeOnly?: boolean
  readonly displayLanguage?: string
  readonly designations?: boolean
  readonly excludeNested?: boolean
  readonly versions?: ReadonlyArray<string>
}

export interface Contains {
  readonly system: string
  readonly version: string | undefined
  readonly code: string
  readonly display: string | undefined
  readonly inactive: boolean | undefined
  readonly designation: ReadonlyArray<Designation> | undefined
  readonly contains: ReadonlyArray<Contains> | undefined
}

export interface Parameter {
  readonly name: string
  readonly value: string | number | boolean
}

export interface Expansion {
  readonly resourceType: "ValueSet"
  readonly url: string
  readonly version: string | undefined
  readonly expansion: {
    readonly timestamp: string
    readonly total: number
    readonly offset: number | undefined
    readonly parameter: ReadonlyArray<Parameter>
    readonly contains: ReadonlyArray<Contains>
  }
}

export interface Terminology {
  readonly lookup: (request: LookupRequest) => Effect.Effect<Lookup, Failure>
  readonly subsumes: (request: PairRequest) => Effect.Effect<Subsumption, Failure>
  readonly compare: (request: PairRequest) => Effect.Effect<Match, Failure>
  readonly expand: (request: ExpandRequest) => Effect.Effect<Expansion, Failure>
}

export class TerminologyPort extends Context.Tag("Terminology")<TerminologyPort, Terminology>() {}
