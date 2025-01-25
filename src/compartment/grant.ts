import { Effect } from "effect"
import type { Access, Grant, Scope } from "../auth/scope.js"
import { Forbidden, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Manager } from "./definition.js"
import type { Limit } from "./filter.js"

const CODE = "patient"

const covers = (scope: Scope, access: Access): boolean =>
  (scope.action === "*" || scope.action === access.action) &&
  (scope.type === "*" || scope.type === access.type)

export const limitsOf = (
  manager: Manager,
  grant: Grant,
  access: Access
): Effect.Effect<ReadonlyArray<Limit>, Failure> =>
  Effect.gen(function* () {
    const found = grant.scopes.filter((scope) => covers(scope, access))
    if (found.length === 0) {
      return yield* Effect.fail(
        new Forbidden({ action: `${access.action} ${access.type}` })
      )
    }
    if (found.some((scope) => scope.compartment === undefined)) return []
    const other = found.find((scope) => scope.kind !== CODE)
    if (other !== undefined) {
      return yield* Effect.fail(
        new Rejected({ reason: `compartment scope not supported: ${other.kind}` })
      )
    }
    const ids = [...new Set(found.map((scope) => scope.compartment ?? ""))]
    return [{ definition: yield* manager.get(CODE), ids }]
  })
