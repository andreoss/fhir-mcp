import { Context, Effect, Layer } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Versions } from "../core/interactions.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"

type Work<A, R> = Effect.Effect<A, Failure, R>

export interface Boundary {
  readonly lanes: number
  readonly within: <A, R>(work: Work<A, R>) => Work<A, R>
}

export class Unit extends Context.Tag("BundleUnit")<Unit, Boundary>() {}

export const loose: Boundary = {
  lanes: Number.POSITIVE_INFINITY,
  within: (work) => work
}

export interface Bound {
  readonly store: Versioned
  readonly boundary: Boundary
}

const CONTROL = new Set(["begin transaction", "commit", "rollback"])

const fault = (): Failure => new Unavailable({ dependency: "store" })

const shielded = (connection: DuckDBConnection, held: () => boolean): DuckDBConnection => {
  const shim = Object.create(connection) as DuckDBConnection
  shim.runAndReadAll = (sql, values, types) =>
    held() && CONTROL.has(sql)
      ? connection.runAndReadAll("select 1")
      : connection.runAndReadAll(sql, values, types)
  return shim
}

export const unitOn = (connection: DuckDBConnection): Effect.Effect<Bound, Failure> =>
  Effect.gen(function* () {
    let held = false
    const store = yield* versionedOn(shielded(connection, () => held))
    const control = (sql: string) =>
      Effect.tryPromise({
        try: async () => {
          await connection.run(sql)
        },
        catch: fault
      })
    const start = control("begin transaction").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          held = true
        })
      )
    )
    const settle = (sql: string) =>
      Effect.sync(() => {
        held = false
      }).pipe(Effect.zipRight(control(sql)))
    const within = <A, R>(work: Work<A, R>): Work<A, R> =>
      Effect.zipRight(
        start,
        work.pipe(
          Effect.tap(() => settle("commit")),
          Effect.tapErrorCause(() => Effect.ignore(settle("rollback")))
        )
      )
    return { store, boundary: { lanes: 1, within } }
  })

export const opened = (path: string): Effect.Effect<Bound, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: fault
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(Effect.flatMap(unitOn))

export const layer = (path: string): Layer.Layer<Versions | Unit, Failure> =>
  Layer.scopedContext(
    Effect.map(opened(path), (bound) =>
      Context.make(Versions, bound.store).pipe(Context.add(Unit, bound.boundary))
    )
  )
