import { Context, Effect, Layer } from "effect"
import type { Duration } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { cacheOn } from "./cache.js"
import { admit as allowed } from "./gate.js"
import type { Change, Definition, Entry, Progress, Report, Snapshot } from "./model.js"
import { registryOn } from "./registry.js"
import { Reindexer } from "./reindex.js"
import type { Queue } from "./reindex.js"
import { post, query, update } from "./status.js"

export interface Manager {
  readonly list: Effect.Effect<ReadonlyArray<Entry>, Failure>
  readonly read: (type: string, name: string) => Effect.Effect<Entry, Failure>
  readonly create: (definition: Definition) => Effect.Effect<Report, Failure>
  readonly revise: (
    definition: Definition,
    expected: number
  ) => Effect.Effect<Report, Failure>
  readonly retire: (
    type: string,
    name: string,
    expected: number
  ) => Effect.Effect<void, Failure>
  readonly status: (type: string, name: string) => Effect.Effect<Report, Failure>
  readonly post: (change: Change) => Effect.Effect<Report, Failure>
  readonly update: (progress: Progress) => Effect.Effect<Report, Failure>
  readonly admit: (
    type: string,
    entries: ReadonlyArray<readonly [string, string]>
  ) => Effect.Effect<void, Failure>
  readonly converge: Effect.Effect<Snapshot, Failure>
  readonly watch: (interval: Duration.DurationInput) => Effect.Effect<void, Failure>
}

export class Params extends Context.Tag("params/Manager")<Params, Manager>() {}

export const managerOn = (
  connection: DuckDBConnection,
  queue: Queue
): Effect.Effect<Manager, Failure> =>
  Effect.gen(function* () {
    const registry = yield* registryOn(connection)
    yield* registry.install
    const cache = yield* cacheOn(registry)

    const submitted = (entry: Entry) =>
      queue.submit({
        type: entry.definition.type,
        name: entry.definition.name,
        version: entry.version
      })

    const settled = (entry: Entry) =>
      submitted(entry).pipe(
        Effect.zipRight(query(registry, entry.definition.type, entry.definition.name))
      )

    return {
      list: registry.all,
      read: registry.find,
      create: (definition) => registry.create(definition).pipe(Effect.flatMap(settled)),
      revise: (definition, expected) =>
        registry.revise(definition, expected).pipe(Effect.flatMap(settled)),
      retire: registry.remove,
      status: (type, name) => query(registry, type, name),
      post: (change) => post(registry, change),
      update: (progress) => update(registry, progress),
      admit: (type, entries) =>
        cache.current.pipe(Effect.flatMap((held) => allowed(held, type, entries))),
      converge: cache.current,
      watch: cache.poll
    }
  })

export const layer = (
  path: string,
  interval: Duration.DurationInput
): Layer.Layer<Params, Failure, Reindexer> =>
  Layer.scoped(
    Params,
    Effect.gen(function* () {
      const queue = yield* Reindexer
      const connection = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const instance = await DuckDBInstance.create(path)
            return await instance.connect()
          },
          catch: (): Failure => new Unavailable({ dependency: "store" })
        }),
        (held) => Effect.sync(() => held.closeSync())
      )
      const manager = yield* managerOn(connection, queue)
      yield* Effect.forkScoped(manager.watch(interval))
      return manager
    })
  )
