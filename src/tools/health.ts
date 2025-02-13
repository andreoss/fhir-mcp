import { Effect, Schema } from "effect"
import { load } from "../config/config.js"
import { readiness, storeProbe } from "../host/health.js"
import { open } from "../store/store.js"
import { parse } from "./args.js"
import type { ArgsError } from "./args.js"
import { emit, storePath } from "./result.js"
import type { Outcome } from "./result.js"

export interface Check {
  readonly name: string
  readonly state: string
}

export interface Health {
  readonly action: "health"
  readonly status: "ok" | "failing"
  readonly checks: ReadonlyArray<Check>
}

const failing = (state: string): boolean =>
  state.startsWith("rejected") || state === "down" || state === "timeout"

const exercised = (path: string): Effect.Effect<string> =>
  Effect.scoped(
    Effect.flatMap(open(path), (store) =>
      Effect.map(readiness([storeProbe(store)]), (report) => report.checks[0]?.state ?? "down")
    )
  ).pipe(Effect.orElseSucceed(() => "down"))

export const inspect = (
  given: string | undefined,
  env: Record<string, string | undefined>
): Effect.Effect<Health> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.either(load(env))
    const config =
      decoded._tag === "Right" ? "accepted" : `rejected: ${decoded.left.problems.join("; ")}`
    const path = storePath(given, env)
    const store = yield* exercised(path)
    const checks: ReadonlyArray<Check> = [
      { name: "config", state: config },
      { name: "store", state: store },
      { name: "engine", state: "not-observed" }
    ]
    return {
      action: "health",
      status: checks.some((check) => failing(check.state)) ? "failing" : "ok",
      checks
    }
  })

const spec = {
  flags: [] as ReadonlyArray<string>,
  fields: { store: Schema.optional(Schema.String) }
}

export const run = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>
): Effect.Effect<Outcome, ArgsError> =>
  parse(spec, argv).pipe(
    Effect.flatMap((parsed) => inspect(parsed.options.store, env)),
    Effect.map((found) => emit(found, found.status === "ok" ? 0 : 1))
  )
