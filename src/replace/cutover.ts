import { Effect, Either } from "effect"
import type { Failure } from "../core/outcome.js"
import type { Answer, Request, Side } from "./shadow.js"

export type Where = "origin" | "target"

export interface Probe {
  readonly name: string
  readonly run: Effect.Effect<boolean, Failure>
}

export interface Check {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

export interface Plan {
  readonly before: ReadonlyArray<Probe>
  readonly after: ReadonlyArray<Probe>
}

export interface Router {
  readonly serving: () => Effect.Effect<Where>
  readonly point: (at: Where) => Effect.Effect<void>
  readonly moves: () => Effect.Effect<ReadonlyArray<Where>>
}

export interface Cutover {
  readonly before: ReadonlyArray<Check>
  readonly moved: boolean
  readonly after: ReadonlyArray<Check>
  readonly rolledBack: boolean
  readonly serving: Where
  readonly moves: ReadonlyArray<Where>
}

export const router = (start: Where): Router => {
  let at: Where = start
  const made: Array<Where> = []
  return {
    serving: () => Effect.sync(() => at),
    point: (to) =>
      Effect.sync(() => {
        at = to
        made.push(to)
      }),
    moves: () => Effect.sync(() => [...made])
  }
}

export const via =
  (route: Router, origin: Side, target: Side) =>
  (request: Request): Effect.Effect<Answer> =>
    Effect.flatMap(route.serving(), (at) =>
      at === "origin" ? origin.serve(request) : target.serve(request)
    )

const checked = (probe: Probe): Effect.Effect<Check> =>
  Effect.map(Effect.either(probe.run), (held) => {
    if (Either.isLeft(held)) {
      return { name: probe.name, pass: false, detail: `refused: ${held.left._tag}` }
    }
    const detail = held.right ? "held" : "did not hold"
    return { name: probe.name, pass: held.right, detail }
  })

const gauntlet = (probe: ReadonlyArray<Probe>): Effect.Effect<ReadonlyArray<Check>> =>
  Effect.gen(function* () {
    const out: Array<Check> = []
    for (const one of probe) {
      const held = yield* checked(one)
      out.push(held)
      if (!held.pass) return out
    }
    return out
  })

const holds = (checks: ReadonlyArray<Check>): boolean => checks.every((one) => one.pass)

export const cutover = (route: Router, plan: Plan): Effect.Effect<Cutover> =>
  Effect.gen(function* () {
    const before = yield* gauntlet(plan.before)
    if (!holds(before)) {
      return {
        before,
        moved: false,
        after: [],
        rolledBack: false,
        serving: yield* route.serving(),
        moves: yield* route.moves()
      }
    }
    yield* route.point("target")
    const after = yield* gauntlet(plan.after)
    if (!holds(after)) yield* route.point("origin")
    return {
      before,
      moved: true,
      after,
      rolledBack: !holds(after),
      serving: yield* route.serving(),
      moves: yield* route.moves()
    }
  })
