import { Effect, FiberRef } from "effect"
import { DuckDBConnection } from "@duckdb/node-api"

const lanes = new WeakMap<DuckDBConnection, Effect.Semaphore>()

const holding = FiberRef.unsafeMake<ReadonlySet<DuckDBConnection>>(new Set())

const rootOf = (connection: DuckDBConnection): DuckDBConnection => {
  const parent: unknown = Object.getPrototypeOf(connection)
  return parent instanceof DuckDBConnection ? rootOf(parent) : connection
}

const laneOf = (root: DuckDBConnection): Effect.Semaphore => {
  const found = lanes.get(root)
  if (found !== undefined) return found
  const made = Effect.unsafeMakeSemaphore(1)
  lanes.set(root, made)
  return made
}

export const exclusive =
  (connection: DuckDBConnection) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const root = rootOf(connection)
    return Effect.flatMap(FiberRef.get(holding), (held) =>
      held.has(root)
        ? work
        : laneOf(root).withPermits(1)(
            Effect.locally(work, holding, new Set([...held, root]))
          )
    )
  }
