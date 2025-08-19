import { Effect, Layer } from "effect"
import { load } from "../config/config.js"
import { wiring } from "../host/compose.js"
import { supplied } from "../host/terminology.js"
import { serveOverStdio } from "../protocol/server.js"

const serving = Effect.gen(function* () {
  const config = yield* load(process.env)
  const context = yield* Layer.build(Layer.orDie(wiring(config)))
  const all = Layer.succeedContext(context)
  const terms =
    config.terminologyDir === undefined
      ? undefined
      : Layer.orDie(supplied(config.terminologyDir))
  const server = yield* serveOverStdio(
    all,
    config.allowWrite ? all : undefined,
    all,
    terms,
    config.allowWrite ? all : undefined
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
  return yield* Effect.never
})

await Effect.runPromise(
  Effect.scoped(serving).pipe(
    Effect.catchAll((cause: unknown) =>
      Effect.sync(() => {
        const reason = cause instanceof Error ? cause.message : String(cause)
        process.stderr.write(`${reason}\n`)
        process.exitCode = 1
      })
    )
  )
)
