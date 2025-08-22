import { Effect } from "effect"
import type { Bundle } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Scope } from "../auth/scope.js"
import type { Restriction } from "../engine/restriction.js"
import type { OperationCall, Operations } from "../agent/tools.js"
import { everything } from "./everything.js"
import type { Everything } from "./everything.js"
import type { Grant } from "./grant.js"
import type { Page } from "./page.js"
import { Records } from "./records.js"
import type { Reader } from "./records.js"

const EVERYTHING = "$everything"

const TAKES: ReadonlySet<string> = new Set(["_since", "_till", "_type", "_count", "_ct"])

const readScope = (scope: Scope): boolean => scope.action === "*" || scope.action === "read"

export const permissionOf = (restriction: Restriction): Grant => {
  const held = restriction.grant
  if (held === undefined) return { read: true }
  const scopes = held.scopes.filter(readScope)
  if (scopes.length === 0) return { read: false }
  const types = scopes.some((scope) => scope.type === "*")
    ? undefined
    : [...new Set(scopes.map((scope) => scope.type))]
  const patients = scopes.some((scope) => scope.compartment === undefined)
    ? undefined
    : [...new Set(scopes.map((scope) => scope.compartment ?? ""))]
  return {
    read: true,
    ...(types === undefined ? {} : { types }),
    ...(patients === undefined ? {} : { patients })
  }
}

const single = (
  call: OperationCall,
  name: string
): Effect.Effect<string | undefined, Failure> => {
  const found = call.parameters.filter(([key]) => key === name)
  if (found.length > 1) {
    return Effect.fail(new Rejected({ reason: `${EVERYTHING} takes one ${name}` }))
  }
  return Effect.succeed(found.length === 0 ? undefined : found[0]?.[1])
}

const forEverything = (
  call: OperationCall,
  permission: Grant
): Effect.Effect<Page, Failure, Records> =>
  Effect.gen(function* () {
    for (const [name] of call.parameters) {
      if (!TAKES.has(name)) {
        return yield* Effect.fail(
          new Rejected({ reason: `${EVERYTHING} does not take ${name}` })
        )
      }
    }
    const patient = call.id
    if (patient === undefined) {
      return yield* Effect.fail(new Rejected({ reason: `${EVERYTHING} needs a patient` }))
    }
    const since = yield* single(call, "_since")
    const till = yield* single(call, "_till")
    const types = yield* single(call, "_type")
    const count = yield* single(call, "_count")
    const ct = yield* single(call, "_ct")
    const request: Everything = {
      patient,
      ...(since === undefined ? {} : { since }),
      ...(till === undefined ? {} : { till }),
      ...(types === undefined ? {} : { types: types.split(",") }),
      ...(count === undefined ? {} : { count: Number(count) }),
      ...(ct === undefined ? {} : { ct })
    }
    return yield* everything(request, permission)
  })

export const invoke = (
  call: OperationCall,
  permission: Grant
): Effect.Effect<Bundle, Failure, Records> =>
  call.name === EVERYTHING
    ? forEverything(call, permission)
    : Effect.fail(new Rejected({ reason: `no operation named ${call.name}` }))

export const operationsOn = (
  records: Reader,
  permission: Grant
): Operations => ({
  invoke: (call: OperationCall): Effect.Effect<Bundle, Failure> =>
    Effect.provideService(invoke(call, permission), Records, records)
})
