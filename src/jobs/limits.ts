import { Clock, Duration, Effect, Ref } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Rate {
  readonly count: number
  readonly windowMs: number
}

export interface Ceiling {
  readonly concurrency: number
  readonly rate: Rate | undefined
}

export const CEILING: Ceiling = { concurrency: 4, rate: undefined }

export const ceilings = (
  kinds: ReadonlyArray<string>,
  overrides: Readonly<Record<string, Ceiling>> = {}
): Readonly<Record<string, Ceiling>> =>
  Object.fromEntries(kinds.map((kind) => [kind, overrides[kind] ?? CEILING]))

export interface Limiter {
  readonly gate: <A, E, R>(
    kind: string,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | Failure, R>
}

interface Window {
  readonly tokens: number
  readonly since: number
}

interface Gate {
  readonly permit: Effect.Semaphore
  readonly rate: Rate | undefined
  readonly window: Ref.Ref<Window>
}

const admit = (rate: Rate, window: Ref.Ref<Window>): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const at = yield* Clock.currentTimeMillis
      const wait = yield* Ref.modify(window, (held): [number, Window] => {
        if (at - held.since >= rate.windowMs) {
          return [0, { tokens: rate.count - 1, since: at }]
        }
        if (held.tokens > 0) {
          return [0, { tokens: held.tokens - 1, since: held.since }]
        }
        return [held.since + rate.windowMs - at, held]
      })
      if (wait <= 0) return
      yield* Effect.sleep(Duration.millis(wait))
    }
  })

export const limiter = (
  declared: Readonly<Record<string, Ceiling>>
): Effect.Effect<Limiter> =>
  Effect.gen(function* () {
    const gates = new Map<string, Gate>()
    for (const [kind, ceiling] of Object.entries(declared)) {
      const permit = yield* Effect.makeSemaphore(Math.max(1, ceiling.concurrency))
      const window = yield* Ref.make<Window>({
        tokens: ceiling.rate?.count ?? 0,
        since: 0
      })
      gates.set(kind, { permit, rate: ceiling.rate, window })
    }
    const gate = <A, E, R>(kind: string, work: Effect.Effect<A, E, R>) => {
      const found = gates.get(kind)
      if (found === undefined) {
        return Effect.fail(
          new Rejected({ reason: `no ceiling declared for job kind: ${kind}` })
        )
      }
      const held = found.permit.withPermits(1)(work)
      return found.rate === undefined
        ? held
        : Effect.zipRight(admit(found.rate, found.window), held)
    }
    return { gate }
  })
