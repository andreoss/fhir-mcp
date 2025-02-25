import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ConfigError, load } from "../config/config.js"
import { serveOverStdio } from "../protocol/server.js"
import { wiring } from "./compose.js"

export class Unserved extends Error {
  constructor(transport: string) {
    super(`transport not served in this build: ${transport}`)
    this.name = "Unserved"
  }
}

export const start = (
  env: Record<string, string | undefined>
): Effect.Effect<Server, ConfigError | Unserved | Error, Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* load(env)
    if (config.transport !== "stdio") {
      return yield* Effect.fail(new Unserved(config.transport))
    }
    const context = yield* Layer.build(Layer.orDie(wiring(config)))
    const all = Layer.succeedContext(context)
    return yield* serveOverStdio(all, config.allowWrite ? all : undefined, all)
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
