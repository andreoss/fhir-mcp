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
import { versionedOn } from "../store/versioned.js"
import { engineOn } from "../store/store.js"

export type Wiring = FhirEngine | Versions | Rules | Grant | Journal

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

export const shared = (path: string): Layer.Layer<FhirEngine | Versions, Failure> =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const connection = yield* connect(path)
      const engine = yield* engineOn(connection)
      const versioned = yield* versionedOn(connection)
      return Context.make(FhirEngine, engine).pipe(Context.add(Versions, versioned))
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
    shared(config.store.path),
    Layer.succeed(Rules, defaults),
    grantOf(config, randomUUID()),
    journalToErrors
  )
