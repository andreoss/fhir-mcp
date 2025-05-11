import { Duration, Effect, Either, Ref } from "effect"
import { Conflict, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export type Fault = "transient" | "permanent"

export interface Plan {
  readonly attempts: number
  readonly baseMs: number
  readonly capMs: number
  readonly parallel: number
}

export const PLAN: Plan = {
  attempts: 3,
  baseMs: 100,
  capMs: 2_000,
  parallel: 2
}

export interface Retrier {
  readonly run: <A>(
    work: Effect.Effect<A, Failure>
  ) => Effect.Effect<A, Failure>
  readonly peak: Effect.Effect<number>
}

export const fault = (failure: Failure): Fault => {
  switch (failure._tag) {
    case "Unavailable":
      return "transient"
    case "Conflict":
    case "NotFound":
    case "Gone":
    case "Rejected":
    case "Forbidden":
      return "permanent"
  }
}

const INVALID: ReadonlyArray<string> = [
  "binder error",
  "catalog error",
  "parser error",
  "conversion error",
  "invalid input"
]

const PASSING: ReadonlyArray<string> = [
  "io error",
  "connection",
  "out of memory",
  "timed out",
  "interrupt"
]

export const translate = (cause: unknown): Failure => {
  const text = String(cause instanceof Error ? cause.message : cause)
    .toLowerCase()
  if (text.includes("constraint error")) {
    return new Conflict({ reason: "version already written" })
  }
  if (INVALID.some((mark) => text.includes(mark))) {
    return new Rejected({ reason: "store refused the statement" })
  }
  if (PASSING.some((mark) => text.includes(mark))) {
    return new Unavailable({ dependency: "store" })
  }
  return new Rejected({ reason: "store failed for an unclassified reason" })
}

export const waitFor = (plan: Plan, attempt: number): number =>
  Math.min(plan.baseMs * Math.pow(2, attempt - 1), plan.capMs)

export const retrier = (plan: Plan): Effect.Effect<Retrier> =>
  Effect.gen(function* () {
    const permit = yield* Effect.makeSemaphore(Math.max(1, plan.parallel))
    const live = yield* Ref.make(0)
    const most = yield* Ref.make(0)

    const counted = <A>(work: Effect.Effect<A, Failure>) =>
      Effect.acquireUseRelease(
        Effect.flatMap(Ref.updateAndGet(live, (held) => held + 1), (held) =>
          Ref.update(most, (top) => Math.max(top, held))
        ),
        () => work,
        () => Ref.update(live, (held) => held - 1)
      )

    const again = <A>(work: Effect.Effect<A, Failure>, attempt: number) =>
      permit.withPermits(1)(
        Effect.zipRight(
          Effect.sleep(Duration.millis(waitFor(plan, attempt - 1))),
          counted(work)
        )
      )

    const run = <A>(
      work: Effect.Effect<A, Failure>
    ): Effect.Effect<A, Failure> =>
      Effect.gen(function* () {
        for (let attempt = 1; ; attempt++) {
          const outcome = yield* Effect.either(
            attempt === 1 ? work : again(work, attempt)
          )
          if (Either.isRight(outcome)) return outcome.right
          const failure = outcome.left
          if (fault(failure) === "permanent" || attempt >= plan.attempts) {
            return yield* Effect.fail(failure)
          }
        }
      })

    return { run, peak: Ref.get(most) }
  })
