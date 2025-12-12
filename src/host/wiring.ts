import { Effect, Either } from "effect"
import type { Scope } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { createPrivateKey } from "node:crypto"
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
import { handlers } from "../bulk/bulk.js"
import { depotOn } from "../bulk/depot.js"
import type { Depot } from "../bulk/depot.js"
import { unitOn } from "../bundle/unit.js"
import type { Bound as Bundle } from "../bundle/unit.js"
import { desk } from "../jobs/service.js"
import type { Desk } from "../jobs/service.js"
import { queueOn } from "../jobs/queue.js"
import { start } from "../jobs/worker.js"
import { ensure } from "../store/query.js"
import { engineOn } from "../store/store.js"
import type { Store } from "../store/store.js"
import { versionedOn } from "../store/versioned.js"
import { typed } from "./typed.js"
import type { Failure } from "../core/outcome.js"
import { mint } from "../auth/mint.js"
import { basicCredit, bearerCredit, remote, smartCredit } from "../emr/adapter.js"
import type { Credit, Send } from "../emr/adapter.js"
import type { AuthSmart, BackendConfig } from "../emr/backend.js"
import { lifecycle } from "../emr/lifecycle.js"
import type { Lifecycle } from "../emr/lifecycle.js"
import { cache as tokenCache } from "../emr/token.js"
import type { AssertionSigner, IssuerConfig, Post, Time } from "../emr/token.js"
import { node } from "../emr/wire.js"
import type { Bound } from "../emr/wire.js"

export interface Startup {
  readonly deps: Deps
  readonly store: Store
  readonly versions: VersionedStore
  readonly depot: Depot
  readonly jobs: Desk
  readonly unit: Bundle
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

export const jobbing = (
  connection: DuckDBConnection,
  depot: Depot
): Effect.Effect<Desk, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* queueOn(connection)
    const registry = handlers(yield* versionedOn(connection), depot)
    const worker = yield* start(queue, registry)
    yield* Effect.addFinalizer(() => Effect.orDie(worker.stop))
    return desk(queue, registry)
  })

export const startup = (
  connection: DuckDBConnection
): Effect.Effect<Startup, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* engineOn(connection)
    const unit = yield* unitOn(connection)
    const depot = yield* depotOn(connection)
    return {
      deps: yield* started(connection),
      store,
      versions: typed(connection, unit.store),
      unit,
      depot,
      jobs: yield* jobbing(connection, depot)
    }
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

export const boundOf = (backend: BackendConfig): Bound => ({
  dependency: backend.name,
  timeoutMs: backend.timeoutMs,
  retryAfterMs: backend.retryAfterMs
})

export const timeNow: Time = { ms: () => Date.now() }

export const postOf = (backend: BackendConfig): Post => ({
  post: (url, body) =>
    node().send({
      method: "POST",
      url,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body,
      bound: boundOf(backend)
    })
})

export const issuerOf = (auth: AuthSmart): IssuerConfig => ({
  tokenUrl: auth.tokenUrl,
  clientId: auth.clientId,
  kid: auth.kid,
  assertionLifetimeMs: auth.assertionLifetimeMs,
  refreshMarginMs: auth.refreshMarginMs,
  ...(auth.scope === undefined ? {} : { scope: auth.scope })
})

export const signerOf = (auth: AuthSmart): AssertionSigner => {
  const key = createPrivateKey(auth.key)
  return {
    kid: auth.kid,
    sign: (claims) => mint(claims, { alg: "RS384", key, kid: auth.kid })
  }
}

export const creditOf = (backend: BackendConfig): Credit => {
  switch (backend.auth.scheme) {
    case "none":
      return () => Effect.succeed({})
    case "bearer":
      return bearerCredit(backend.auth.token)
    case "basic":
      return basicCredit(backend.auth.username, backend.auth.password)
    case "smart":
      return smartCredit({
        lf: credentialsOf(backend),
        clock: timeNow,
        post: postOf(backend),
        dependency: backend.name
      })
  }
}

export const credentialsOf = (backend: BackendConfig): Lifecycle => {
  if (backend.auth === undefined || backend.auth.scheme !== "smart") {
    throw new Error(`${backend.name}: no issuer without a smart scheme`)
  }
  const issuer = issuerOf(backend.auth)
  const signer = signerOf(backend.auth)
  return lifecycle(issuer, signer, tokenCache(issuer, signer))
}

export const overTransport = (
  backend: BackendConfig,
  credit: Credit,
  send: Send
): Engine =>
  remote({ baseUrl: backend.baseUrl, bound: boundOf(backend), credit, send })

export const remoteEngine = (backend: BackendConfig): Engine =>
  overTransport(backend, creditOf(backend), node().send)

export const engineOf = (
  held: Startup,
  restriction: Restriction,
  config: Config,
  remote: (backend: BackendConfig) => Engine = remoteEngine,
  local: (held: Startup, restriction: Restriction) => Engine = binding
): Engine =>
  config.emr === undefined ? local(held, restriction) : remote(config.emr)

