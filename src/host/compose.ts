import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Config } from "../config/config.js"
import { Rules, Versions, defaults } from "../core/interactions.js"
import { FhirEngine } from "../core/engine.js"
import { Grant, Journal } from "../agent/write.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Metrics } from "../obs/metrics.js"
import type { TerminologyPort } from "../terminology/port.js"
import { observed } from "./log.js"
import { supplied } from "./terminology.js"
import { binding, restrictionOf, startup } from "./wiring.js"

export type Wiring =
  | FhirEngine
  | Versions
  | Rules
  | Grant
  | Journal
  | TerminologyPort
  | Metrics

const connect = (path: string): Effect.Effect<DuckDBConnection, Failure, never> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: () => new Unavailable({ dependency: "store" })
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ) as unknown as Effect.Effect<DuckDBConnection, Failure, never>

export const served = (config: Config): Layer.Layer<FhirEngine | Versions, Failure> =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const held = yield* startup(yield* connect(config.store.path))
      const engine = binding(held, restrictionOf(config))
      return Context.make(FhirEngine, engine).pipe(Context.add(Versions, held.versions))
    })
  )

export const grantOf = (config: Config, correlation: string): Layer.Layer<Grant> =>
  Layer.succeed(Grant, { write: config.allowWrite, correlation })

export const journalToErrors: Layer.Layer<Journal> = Layer.succeed(Journal, {
  note: (entry) =>
    Effect.sync(() => {
      process.stderr.write(`${JSON.stringify(entry)}\n`)
    })
})

export const wiring = (config: Config): Layer.Layer<Wiring, Failure> =>
  Layer.mergeAll(
    served(config),
    Layer.succeed(Rules, defaults),
    grantOf(config, randomUUID()),
    journalToErrors,
    supplied(config.terminologyDir),
    observed(config.logLevel)
  )
