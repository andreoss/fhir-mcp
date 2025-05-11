import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Request } from "./shadow.js"
import { KINDS } from "./diff.js"
import type { Kind, Report } from "./diff.js"

export interface Policy {
  readonly agreed: string
  readonly empty: ReadonlyArray<Kind>
  readonly tolerated: ReadonlyArray<Kind>
  readonly budget: number
}

export interface Breach {
  readonly kind: Kind
  readonly count: number
  readonly first: Request
}

export interface Verdict {
  readonly pass: boolean
  readonly policy: Policy
  readonly breach: ReadonlyArray<Breach>
  readonly allowed: ReadonlyArray<Breach>
  readonly reason: ReadonlyArray<string>
}

export const AGREED: Policy = {
  agreed: "before the run, pending the naming of an incumbent",
  empty: ["only-left", "only-right", "count", "error"],
  tolerated: ["field"],
  budget: 5
}

export const declared = (policy: Policy): Effect.Effect<Policy, Failure> => {
  if (policy.agreed.length === 0) {
    return Effect.fail(new Rejected({ reason: "policy records no agreement" }))
  }
  if (!Number.isInteger(policy.budget) || policy.budget < 0) {
    return Effect.fail(new Rejected({ reason: `budget is not a budget: ${policy.budget}` }))
  }
  const classified = [...policy.empty, ...policy.tolerated]
  const twice = classified.filter((kind, at) => classified.indexOf(kind) !== at)
  if (twice.length > 0) {
    return Effect.fail(new Rejected({ reason: `classified twice: ${twice.join(", ")}` }))
  }
  const missing = KINDS.filter((kind) => !classified.includes(kind))
  if (missing.length > 0) {
    return Effect.fail(new Rejected({ reason: `not classified: ${missing.join(", ")}` }))
  }
  return Effect.succeed(policy)
}

const breaches = (kinds: ReadonlyArray<Kind>, found: Report): ReadonlyArray<Breach> =>
  kinds.flatMap((kind) => {
    const held = found.divergence.filter((one) => one.kind === kind)
    const first = held[0]
    return first === undefined ? [] : [{ kind, count: held.length, first: first.request }]
  })

export const check = (policy: Policy, found: Report): Effect.Effect<Verdict, Failure> =>
  Effect.map(declared(policy), () => {
    const breach = breaches(policy.empty, found)
    const allowed = breaches(policy.tolerated, found)
    const spent = allowed.reduce((total, one) => total + one.count, 0)
    const reason = [
      ...breach.map((one) => `${one.kind} is not empty: ${one.count}`),
      ...(spent > policy.budget
        ? [`tolerated divergence ${spent} is over the budget of ${policy.budget}`]
        : [])
    ]
    return { pass: reason.length === 0, policy, breach, allowed, reason }
  })

export const gated = (
  policy: Policy,
  run: Effect.Effect<Report, Failure>
): Effect.Effect<Verdict, Failure> =>
  Effect.flatMap(declared(policy), () =>
    Effect.flatMap(run, (found) => check(policy, found))
  )
