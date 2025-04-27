import { Effect, Ref, SynchronizedRef } from "effect"
import type { Duration } from "effect"
import type { Failure } from "../core/outcome.js"
import type { Snapshot } from "./model.js"
import type { Registry } from "./registry.js"

export interface Cache {
  readonly cached: Effect.Effect<Snapshot>
  readonly current: Effect.Effect<Snapshot, Failure>
  readonly refresh: Effect.Effect<Snapshot, Failure>
  readonly poll: (interval: Duration.DurationInput) => Effect.Effect<void, Failure>
  readonly loads: Effect.Effect<number>
}

export const cacheOn = (registry: Registry): Effect.Effect<Cache, Failure> =>
  Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    const reload = registry.snapshot.pipe(
      Effect.tap(() => Ref.update(counter, (count) => count + 1))
    )
    const held = yield* SynchronizedRef.make(yield* reload)
    const refresh = SynchronizedRef.updateAndGetEffect(held, () => reload)
    const current = SynchronizedRef.updateAndGetEffect(held, (one) =>
      registry.epoch.pipe(
        Effect.flatMap((seen) => (seen === one.epoch ? Effect.succeed(one) : reload))
      )
    )
    const poll = (interval: Duration.DurationInput) =>
      Effect.forever(Effect.zipRight(Effect.sleep(interval), current))
    return {
      cached: SynchronizedRef.get(held),
      current,
      refresh,
      poll,
      loads: Ref.get(counter)
    }
  })
