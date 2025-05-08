import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ConfigError, load } from "../config/config.js"
import { build, serveOverStdio } from "../protocol/server.js"
import { bridged } from "../protocol/bridge.js"
import { serve } from "../protocol/http.js"
import type { Endpoint, Options, TransportError } from "../protocol/http.js"
import { wiring } from "./compose.js"
import { asConfigured, modeOf, terminated } from "./tls.js"

import type { Mode } from "./tls.js"

export type { Mode } from "./tls.js"

export interface Running {
  readonly mode: Mode
  readonly server: Server
  readonly endpoint: Endpoint | undefined
}

export const start = (
  env: Record<string, string | undefined>
): Effect.Effect<Running, ConfigError | TransportError | Error, Scope.Scope> =>
  Effect.gen(function* () {
    const mode = modeOf(env)
    const config = yield* load(asConfigured(env, mode))
    const context = yield* Layer.build(Layer.orDie(wiring(config)))
    const all = Layer.succeedContext(context)
    const writes = config.allowWrite ? all : undefined
    if (mode === "stdio") {
      const server = yield* serveOverStdio(all, writes, all, undefined, writes)
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
      return { mode, server, endpoint: undefined }
    }
    const server = build(all, writes, all, undefined, writes)
    yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
    const bridge = yield* bridged(server)
    const options: Options = { deletable: true }
    const secured: Options =
      mode === "https" ? { ...options, secure: yield* terminated(env) } : options
    const endpoint = yield* serve(config, bridge.handler, secured)
    bridge.attach(endpoint)
    yield* Effect.addFinalizer(() => endpoint.close)
    return { mode, server, endpoint }
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
