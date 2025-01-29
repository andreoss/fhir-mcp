import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { SCHEMA_VERSION, engineOn } from "../store/store.js"
import { versionedOn } from "../store/versioned.js"
import type { Failure } from "../core/outcome.js"
import { Flag, parse } from "./args.js"
import type { ArgsError } from "./args.js"
import { connect, currentVersion } from "./db.js"
import { emit, storePath } from "./result.js"
import type { Outcome } from "./result.js"

export type Action = "version" | "next" | "latest"

export interface Step {
  readonly version: number
  readonly apply: (connection: DuckDBConnection) => Effect.Effect<void, Failure>
}

export interface Report {
  readonly action: Action
  readonly from: number
  readonly to: number
  readonly applied: ReadonlyArray<number>
  readonly forced: boolean
}

export const STEPS: ReadonlyArray<Step> = [
  {
    version: SCHEMA_VERSION,
    apply: (connection) =>
      Effect.asVoid(Effect.zip(engineOn(connection), versionedOn(connection)))
  }
]

const chosen = (action: Action, from: number, force: boolean): ReadonlyArray<Step> => {
  const again = force ? STEPS.filter((step) => step.version <= from) : []
  const ahead = STEPS.filter((step) => step.version > from)
  const ordered = [...again, ...ahead].sort((a, b) => a.version - b.version)
  return action === "next" ? ordered.slice(0, 1) : ordered
}

export const migrate = (
  connection: DuckDBConnection,
  action: Action,
  force: boolean
): Effect.Effect<Report, Failure> =>
  Effect.gen(function* () {
    const from = yield* currentVersion(connection)
    if (action === "version") {
      return { action, from, to: from, applied: [], forced: force }
    }
    const steps = chosen(action, from, force)
    for (const step of steps) {
      yield* step.apply(connection)
    }
    const to = yield* currentVersion(connection)
    return { action, from, to, applied: steps.map((step) => step.version), forced: force }
  })

const spec = {
  verbs: ["version", "next", "latest"] as ReadonlyArray<string>,
  flags: ["force"] as ReadonlyArray<string>,
  fields: {
    store: Schema.optional(Schema.String),
    force: Flag
  }
}

export const run = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>
): Effect.Effect<Outcome, ArgsError | Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const parsed = yield* parse(spec, argv)
    const connection = yield* connect(storePath(parsed.options.store, env))
    const report = yield* migrate(connection, parsed.verb as Action, parsed.options.force)
    return emit(report)
  })
