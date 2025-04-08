import { Effect } from "effect"
import { filesLayer } from "../terminology/load.js"
import { fromDirectory } from "../terminology/terminology.js"
import type { Sources } from "../terminology/system.js"
import type { Failure } from "../core/outcome.js"

const empty: Sources = {}

export const terminology = (dir: string | undefined): Effect.Effect<Sources, Failure> =>
  dir === undefined
    ? Effect.succeed(empty)
    : fromDirectory(dir, empty).pipe(Effect.provide(filesLayer))
