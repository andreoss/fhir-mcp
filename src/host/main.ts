import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ConfigError, load } from "../config/config.js"
import type { Config } from "../config/config.js"
import { FhirEngine } from "../core/engine.js"
import { serveOverStdio } from "../protocol/server.js"
import { open } from "../store/store.js"

export class Unserved extends Error {
  constructor(transport: string) {
    super(`transport not served in this build: ${transport}`)
    this.name = "Unserved"
  }
}

const engineLayer = (config: Config): Layer.Layer<FhirEngine, never, Scope.Scope> =>
  Layer.scoped(FhirEngine, Effect.orDie(open(config.store.path)))

export const start = (
  env: Record<string, string | undefined>
): Effect.Effect<Server, ConfigError | Unserved | Error, Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* load(env)
    if (config.transport !== "stdio") {
      return yield* Effect.fail(new Unserved(config.transport))
    }
    const engine = yield* Layer.build(engineLayer(config)).pipe(
      Effect.map((context) => Layer.succeedContext(context))
    )
    return yield* serveOverStdio(engine)
  })

export const main = (): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      start(process.env).pipe(
        Effect.flatMap(() => Effect.never),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            process.stderr.write(`${error.message}\n`)
            process.exitCode = 1
          })
        )
      )
    )
  )
