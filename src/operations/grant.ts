import { Effect } from "effect"
import { Forbidden } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Grant {
  readonly read: boolean
  readonly types?: ReadonlyArray<string>
  readonly patients?: ReadonlyArray<string>
}

export const covers = (grant: Grant, type: string): boolean =>
  grant.read && (grant.types === undefined || grant.types.includes(type))

export const reaches = (grant: Grant, patient: string): boolean =>
  grant.read && (grant.patients === undefined || grant.patients.includes(patient))

export const allow = (permitted: boolean, action: string): Effect.Effect<void, Failure> =>
  permitted ? Effect.void : Effect.fail(new Forbidden({ action }))
