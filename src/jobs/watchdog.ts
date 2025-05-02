import { Deferred, Duration, Effect, Either, Fiber, Ref } from "effect"
import type { Failure } from "../core/outcome.js"
import type { Durable } from "./queue.js"

export interface Vigil {
  readonly stalledEveryMs: number
  readonly defragEveryMs: number
  readonly purgeEveryMs: number
  readonly retentionMs: number
}

export const VIGIL: Vigil = {
  stalledEveryMs: 30_000,
  defragEveryMs: 900_000,
  purgeEveryMs: 600_000,
  retentionMs: 86_400_000
}

export interface Sweeps {
  readonly reclaimed: number
  readonly compacted: number
  readonly purged: number
  readonly rounds: number
  readonly faults: number
}

const NOTHING: Sweeps = {
  reclaimed: 0,
  compacted: 0,
  purged: 0,
  rounds: 0,
  faults: 0
}

export interface Watch {
  readonly report: Effect.Effect<Sweeps>
  readonly stop: Effect.Effect<Sweeps>
}

type Counter = "reclaimed" | "compacted" | "purged"

export const watch = (
  queue: Durable,
  given: Partial<Vigil> = {}
): Effect.Effect<Watch> =>
  Effect.gen(function* () {
    const plan: Vigil = { ...VIGIL, ...given }
    const halting = yield* Deferred.make<void>()
    const counts = yield* Ref.make<Sweeps>(NOTHING)

    const record = (key: Counter, taken: Either.Either<number, Failure>) =>
      Ref.update(counts, (held): Sweeps =>
        Either.match(taken, {
          onLeft: () => ({
            ...held,
            rounds: held.rounds + 1,
            faults: held.faults + 1
          }),
          onRight: (many) => ({
            ...held,
            rounds: held.rounds + 1,
            [key]: held[key] + many
          })
        })
      )

    const cycle = (
      everyMs: number,
      key: Counter,
      sweep: Effect.Effect<number, Failure>
    ) =>
      Effect.gen(function* () {
        while (!(yield* Deferred.isDone(halting))) {
          yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(everyMs)),
            Deferred.await(halting)
          )
          if (yield* Deferred.isDone(halting)) return
          yield* record(key, yield* Effect.either(sweep))
        }
      })

    const dogs = yield* Effect.forEach(
      [
        cycle(plan.stalledEveryMs, "reclaimed", queue.reclaim()),
        cycle(plan.defragEveryMs, "compacted", queue.defrag()),
        cycle(plan.purgeEveryMs, "purged", queue.purge(plan.retentionMs))
      ],
      (dog) => Effect.forkDaemon(dog)
    )

    const stop = Effect.gen(function* () {
      yield* Deferred.succeed(halting, void 0)
      yield* Fiber.interruptAll(dogs)
      return yield* Ref.get(counts)
    })

    return { report: Ref.get(counts), stop }
  })
