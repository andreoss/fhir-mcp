import { Effect, Layer } from "effect"
import { filesLayer } from "../terminology/load.js"
import { fromDirectory, layer } from "../terminology/terminology.js"
import type { TerminologyPort } from "../terminology/port.js"
import type { Sources } from "../terminology/system.js"
import type { Failure } from "../core/outcome.js"

const empty: Sources = {}

export const terminology = (dir: string | undefined): Effect.Effect<Sources, Failure> =>
  dir === undefined
    ? Effect.succeed(empty)
    : fromDirectory(dir, empty).pipe(Effect.provide(filesLayer))

export const supplied = (
  dir: string | undefined
): Layer.Layer<TerminologyPort, Failure> =>
  Layer.unwrapEffect(Effect.map(terminology(dir), layer))
