import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Config } from "../config/config.js"
import { DepotPort } from "../bulk/depot.js"
import { Unit } from "../bundle/unit.js"
import { Rules, Versions, defaults } from "../core/interactions.js"
import { FhirEngine } from "../core/engine.js"
import { FhirOperations } from "../agent/tools.js"
import { Jobs } from "../jobs/service.js"
import { recordsOn } from "../operations/duck.js"
import { operationsOn, permissionOf } from "../operations/serve.js"
import { asJournal, beside } from "../trail/ledger.js"
import { open } from "../trail/store.js"
import { Grant, Journal } from "../agent/write.js"
import type { Ledger } from "../agent/audit.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Metrics } from "../obs/metrics.js"
import type { TerminologyPort } from "../terminology/port.js"
import { Catalog } from "../versions/port.js"
import { VERSIONS } from "../versions/catalog.js"
import { observed } from "./log.js"
import { supplied } from "./terminology.js"
import { binding, restrictionOf, startup } from "./wiring.js"

export type Wiring =
  | FhirEngine
  | FhirOperations
  | Versions
  | Rules
  | Grant
  | Journal
  | Jobs
  | DepotPort
  | Unit
  | TerminologyPort
  | Catalog
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

export const served = (
  config: Config
): Layer.Layer<
  FhirEngine | FhirOperations | Versions | Jobs | DepotPort | Unit,
  Failure
> =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const held = yield* startup(yield* connect(config.store.path))
      const restriction = restrictionOf(config)
      const engine = binding(held, restriction)
      return Context.make(FhirEngine, engine).pipe(
        Context.add(FhirOperations, operationsOn(
          recordsOn(held.deps.connection),
          permissionOf(restriction)
        )),
        Context.add(Versions, held.versions),
        Context.add(Jobs, held.jobs),
        Context.add(DepotPort, held.depot),
        Context.add(Unit, held.unit.boundary)
      )
    })
  )

export const grantOf = (config: Config, correlation: string): Layer.Layer<Grant> =>
  Layer.succeed(Grant, { write: config.allowWrite, correlation })

export const toErrors: Ledger = {
  note: (entry) =>
    Effect.sync(() => {
      process.stderr.write(`${JSON.stringify(entry)}\n`)
    })
}

export const journalToErrors: Layer.Layer<Journal> = Layer.succeed(Journal, toErrors)

export const trailed = (config: Config): Layer.Layer<Journal, Failure> =>
  Layer.scoped(
    Journal,
    Effect.gen(function* () {
      const trail = yield* open(config.trail.path)
      if (config.trail.retentionMs > 0) {
        yield* trail.purge(config.trail.key, config.trail.retentionMs)
      }
      return beside([toErrors, asJournal(trail)])
    })
  )

export const catalogued: Layer.Layer<Catalog> = Layer.succeed(Catalog, VERSIONS)

export const wiring = (config: Config): Layer.Layer<Wiring, Failure> =>
  Layer.mergeAll(
    served(config),
    catalogued,
    Layer.succeed(Rules, defaults),
    grantOf(config, randomUUID()),
    trailed(config),
    supplied(config.terminologyDir),
    observed(config.logLevel)
  )
