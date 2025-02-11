import { Effect } from "effect"
import type { Access, Grant } from "../auth/scope.js"
import { limitsOf } from "../compartment/grant.js"
import type { Manager } from "../compartment/definition.js"
import type { Limit } from "../compartment/filter.js"
import { Forbidden } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

const sealed: unique symbol = Symbol("engine/restriction")

export interface Restriction {
  readonly [sealed]: true
  readonly name: string
  readonly grant: Grant | undefined
}

export const UNRESTRICTED: Restriction = {
  [sealed]: true,
  name: "unrestricted",
  grant: undefined
}

export const granted = (grant: Grant): Restriction => ({
  [sealed]: true,
  name: "granted",
  grant
})

export const sound = (restriction: Restriction): boolean =>
  (restriction as { readonly [sealed]?: true })[sealed] === true

export const limits = (
  restriction: Restriction,
  manager: Manager,
  access: Access
): Effect.Effect<ReadonlyArray<Limit>, Failure> => {
  if (!sound(restriction)) {
    return Effect.fail(new Forbidden({ action: `${access.action} ${access.type}` }))
  }
  const held = restriction.grant
  return held === undefined ? Effect.succeed([]) : limitsOf(manager, held, access)
}

export const fingerprint = (restriction: Restriction): string =>
  restriction.grant === undefined
    ? restriction.name
    : `${restriction.name}=${JSON.stringify(restriction.grant.scopes)}`
