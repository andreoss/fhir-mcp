import { Effect, Either } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Config } from "../config/config.js"
import { grant } from "../auth/scope.js"
import { manager } from "../compartment/definition.js"
import type { Engine, FhirResource } from "../core/engine.js"
import type { VersionedStore } from "../core/interactions.js"
import { cache } from "../engine/cache.js"
import { UNRESTRICTED, granted } from "../engine/restriction.js"
import type { Restriction } from "../engine/restriction.js"
import { engine as restricted } from "../engine/search.js"
import type { Deps } from "../engine/search.js"
import { registryOn } from "../params/registry.js"
import { ensure } from "../store/query.js"
import { engineOn } from "../store/store.js"
import type { Store } from "../store/store.js"
import { versionedOn } from "../store/versioned.js"
import { typed } from "./typed.js"
import type { Failure } from "../core/outcome.js"

export interface Startup {
  readonly deps: Deps
  readonly store: Store
  readonly versions: VersionedStore
}

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

export const startup = (
  connection: DuckDBConnection
): Effect.Effect<Startup, Failure> =>
  Effect.gen(function* () {
    const store = yield* engineOn(connection)
    const versions = yield* versionedOn(connection)
    return { deps: yield* started(connection), store, versions: typed(connection, versions) }
  })

const reading = (
  held: Startup,
  engine: Engine,
  restriction: Restriction
) => (type: string, id: string): Effect.Effect<FhirResource, Failure> =>
  restriction.grant !== undefined
    ? engine.read(type, id)
    : engine.read(type, id).pipe(
        Effect.catchTag("NotFound", (absent) =>
          Effect.flatMap(Effect.either(held.store.read(type, id)), (found) =>
            Effect.fail<Failure>(
              Either.isLeft(found) && found.left._tag === "Gone" ? found.left : absent
            )
          )
        )
      )

export const binding = (held: Startup, restriction: Restriction): Engine => {
  const engine = restricted(held.deps, restriction)
  return {
    read: reading(held, engine, restriction),
    search: engine.search,
    resourceTypes: engine.resourceTypes,
    searchParameters: engine.searchParameters
  }
}

