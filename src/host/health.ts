import { Clock, Duration, Effect } from "effect"
import type { Engine } from "../core/engine.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export type State = "up" | "down" | "timeout"

export interface Probe {
  readonly name: string
  readonly check: Effect.Effect<unknown, Failure>
}

export interface Reading {
  readonly name: string
  readonly state: State
  readonly millis: number
}

export interface Liveness {
  readonly status: "live"
}

export interface Report {
  readonly status: "ready" | "unready"
  readonly checks: ReadonlyArray<Reading>
  readonly retryAfter: number | undefined
}

export interface Bounds {
  readonly budget: number
  readonly retryAfter: number
}

export const BOUNDS: Bounds = { budget: 2_000, retryAfter: 5 }

export const PROBE_TYPE = "Patient"

export const live = (): Liveness => ({ status: "live" })

export const storeProbe = (engine: Engine, type = PROBE_TYPE): Probe => ({
  name: "store",
  check: engine.search({ type, parameters: [], limit: 1 })
})

const taken = (probe: Probe, budget: number): Effect.Effect<Reading> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const state = yield* probe.check.pipe(
      Effect.as("up" as State),
      Effect.catchAll(() => Effect.succeed("down" as State)),
      Effect.catchAllDefect(() => Effect.succeed("down" as State)),
      Effect.timeoutTo({
        duration: Duration.millis(budget),
        onSuccess: (state: State) => state,
        onTimeout: (): State => "timeout"
      })
    )
    const ended = yield* Clock.currentTimeMillis
    return { name: probe.name, state, millis: ended - started }
  })

export const readiness = (
  probes: ReadonlyArray<Probe>,
  bounds: Bounds = BOUNDS
): Effect.Effect<Report> =>
  Effect.map(
    Effect.forEach(probes, (probe) => taken(probe, bounds.budget), {
      concurrency: "unbounded"
    }),
    (checks) => {
      const well = checks.every((entry) => entry.state === "up")
      return {
        status: well ? "ready" : "unready",
        checks,
        retryAfter: well ? undefined : bounds.retryAfter
      }
    }
  )

export const assured = (report: Report): Effect.Effect<Report, Failure> => {
  const unwell = report.checks.find((entry) => entry.state !== "up")
  return unwell === undefined
    ? Effect.succeed(report)
    : Effect.fail(new Unavailable({ dependency: unwell.name }))
}
