import { Effect } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Config } from "../config/config.js"
import { grant } from "../auth/scope.js"
import { manager } from "../compartment/definition.js"
import { cache } from "../engine/cache.js"
import { UNRESTRICTED, granted } from "../engine/restriction.js"
import type { Restriction } from "../engine/restriction.js"
import type { Deps } from "../engine/search.js"
import { registryOn } from "../params/registry.js"
import { ensure } from "../store/query.js"
import type { Failure } from "../core/outcome.js"

export const restrictionOf = (config: Config): Restriction =>
  config.scopes.length === 0 ? UNRESTRICTED : granted(grant(config.scopes))

export const started = (
  connection: DuckDBConnection
): Effect.Effect<Deps, Failure> =>
  Effect.gen(function* () {
    yield* ensure(connection)
    const registry = yield* registryOn(connection)
    yield* registry.install
    return {
      connection,
      manager: yield* manager(),
      snapshot: registry.snapshot,
      cache: yield* cache(),
      }
  })
