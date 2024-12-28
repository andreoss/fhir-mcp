import { Context, Effect, Layer } from "effect"

export type Level = "debug" | "info" | "warn" | "error"

export interface Event {
  readonly at: string
  readonly level: Level
  readonly kind: string
  readonly correlation: string
  readonly dims: Readonly<Record<string, string>>
}

export interface Sink {
  readonly emit: (event: Event) => Effect.Effect<void>
}

export class TelemetrySink extends Context.Tag("TelemetrySink")<TelemetrySink, Sink>() {}

export interface Capture {
  readonly layer: Layer.Layer<TelemetrySink>
  readonly taken: () => ReadonlyArray<Event>
}

export const line = (event: Event): string =>
  JSON.stringify({
    at: event.at,
    level: event.level,
    kind: event.kind,
    correlation: event.correlation,
    dims: event.dims
  })

export const capture = (): Capture => {
  const seen: Array<Event> = []
  return {
    layer: Layer.succeed(TelemetrySink, {
      emit: (event) =>
        Effect.sync(() => {
          seen.push(event)
        })
    }),
    taken: () => seen
  }
}

export const stream = (write: (text: string) => void): Layer.Layer<TelemetrySink> =>
  Layer.succeed(TelemetrySink, {
    emit: (event) =>
      Effect.sync(() => {
        write(`${line(event)}\n`)
      })
  })

export const errors: Layer.Layer<TelemetrySink> = stream((text) => {
  process.stderr.write(text)
})
