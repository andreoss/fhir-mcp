import { Clock, Context, Effect, Exit, Layer, Ref } from "effect"
import { Telemetry, opDims } from "./telemetry.js"

export const BUCKETS: ReadonlyArray<number> = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000
]

export interface Series {
  readonly op: string
  readonly type: string
  readonly outcome: string
  readonly count: number
  readonly sum: number
  readonly buckets: ReadonlyArray<number>
}

export interface Meter {
  readonly record: (
    op: string,
    type: string,
    outcome: string,
    ms: number
  ) => Effect.Effect<void>
  readonly time: <A, E, R>(
    op: string,
    type: string,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
  readonly snapshot: Effect.Effect<ReadonlyArray<Series>>
}

export class Metrics extends Context.Tag("Metrics")<Metrics, Meter>() {}

const key = (series: Series): string => `${series.op}|${series.type}|${series.outcome}`

const started = (op: string, type: string, outcome: string): Series => ({
  op,
  type,
  outcome,
  count: 0,
  sum: 0,
  buckets: BUCKETS.map(() => 0)
})

const observed = (series: Series, ms: number): Series => ({
  ...series,
  count: series.count + 1,
  sum: series.sum + ms,
  buckets: BUCKETS.map((edge, index) => (series.buckets[index] ?? 0) + (ms <= edge ? 1 : 0))
})

const make = Effect.gen(function* () {
  const telemetry = yield* Telemetry
  const cells = yield* Ref.make(new Map<string, Series>())

  const record = (op: string, type: string, outcome: string, ms: number) =>
    Effect.gen(function* () {
      const dims = opDims(op, type, outcome)
      const named = started(dims.op, dims.type, dims.outcome)
      yield* Ref.update(cells, (held) => {
        held.set(key(named), observed(held.get(key(named)) ?? named, Math.max(0, ms)))
        return held
      })
      yield* telemetry.emit("op", dims, outcome === "failure" ? "warn" : "info")
    })

  const time = <A, E, R>(op: string, type: string, work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const began = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(work)
      const ended = yield* Clock.currentTimeMillis
      yield* record(op, type, Exit.isSuccess(exit) ? "success" : "failure", ended - began)
      return yield* exit
    })

  const snapshot = Ref.get(cells).pipe(
    Effect.map((held) => [...held.values()].sort((a, b) => key(a).localeCompare(key(b))))
  )

  return Metrics.of({ record, time, snapshot })
})

export const layer = (): Layer.Layer<Metrics, never, Telemetry> => Layer.effect(Metrics, make)
