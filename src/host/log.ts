import { Effect, Layer } from "effect"
import { layer as metering } from "../obs/metrics.js"
import type { Metrics } from "../obs/metrics.js"
import { TelemetrySink, line } from "../obs/sink.js"
import type { Level } from "../obs/sink.js"
import { layer as emitting } from "../obs/telemetry.js"

const RANK: Readonly<Record<Level, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

const toErrors = (text: string): void => {
  process.stderr.write(text)
}

export const permits = (level: Level, at: Level): boolean => RANK[at] >= RANK[level]

export const sink = (
  level: Level,
  write: (text: string) => void = toErrors
): Layer.Layer<TelemetrySink> =>
  Layer.succeed(TelemetrySink, {
    emit: (event) =>
      Effect.sync(() => {
        if (permits(level, event.level)) write(`${line(event)}\n`)
      })
  })

export const observed = (
  level: Level,
  write?: (text: string) => void
): Layer.Layer<Metrics> =>
  Layer.provide(metering(), Layer.provide(emitting(), sink(level, write)))
