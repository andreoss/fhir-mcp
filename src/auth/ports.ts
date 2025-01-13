import { Context, Layer } from "effect"
import type { Effect } from "effect"
import type { Unavailable } from "../core/outcome.js"

export interface Time {
  readonly seconds: () => number
}

export class Clock extends Context.Tag("auth/Clock")<Clock, Time>() {}

export const systemClock: Layer.Layer<Clock> = Layer.succeed(Clock, {
  seconds: () => Math.floor(Date.now() / 1000)
})

export const clockAt = (seconds: number): Layer.Layer<Clock> =>
  Layer.succeed(Clock, { seconds: () => seconds })

export interface Answer {
  readonly status: number
  readonly url: string
  readonly body: unknown
}

export interface Fetcher {
  readonly get: (url: string) => Effect.Effect<Answer, Unavailable>
}

export class Net extends Context.Tag("auth/Net")<Net, Fetcher>() {}
