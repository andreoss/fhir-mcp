import { Effect } from "effect"
import type { Config } from "../config/config.js"
import { NotFound } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Endpoints {
  readonly issuer?: string
  readonly jwks?: string
  readonly authorization?: string
  readonly token?: string
  readonly registration?: string
  readonly introspection?: string
}

export interface Authz {
  readonly endpoints: Endpoints
  readonly capabilities: ReadonlyArray<string>
  readonly scopes: ReadonlyArray<string>
  readonly grants: ReadonlyArray<string>
  readonly pkce: ReadonlyArray<string>
}

export interface SmartConfiguration {
  readonly issuer?: string
  readonly jwks_uri?: string
  readonly authorization_endpoint?: string
  readonly token_endpoint?: string
  readonly registration_endpoint?: string
  readonly introspection_endpoint?: string
  readonly capabilities: ReadonlyArray<string>
  readonly scopes_supported: ReadonlyArray<string>
  readonly grant_types_supported: ReadonlyArray<string>
  readonly code_challenge_methods_supported: ReadonlyArray<string>
}

export const NONE: Authz = {
  endpoints: {},
  capabilities: [],
  scopes: [],
  grants: [],
  pkce: []
}

export const document = (authz: Authz): SmartConfiguration => {
  const at = authz.endpoints
  return {
    ...(at.issuer === undefined ? {} : { issuer: at.issuer }),
    ...(at.jwks === undefined ? {} : { jwks_uri: at.jwks }),
    ...(at.authorization === undefined
      ? {}
      : { authorization_endpoint: at.authorization }),
    ...(at.token === undefined ? {} : { token_endpoint: at.token }),
    ...(at.registration === undefined
      ? {}
      : { registration_endpoint: at.registration }),
    ...(at.introspection === undefined
      ? {}
      : { introspection_endpoint: at.introspection }),
    capabilities: [...authz.capabilities],
    scopes_supported: [...authz.scopes],
    grant_types_supported: [...authz.grants],
    code_challenge_methods_supported: [...authz.pkce]
  }
}

export const discovery = (
  config: Config,
  authz: Authz = NONE
): Effect.Effect<SmartConfiguration, Failure> =>
  config.transport === "http"
    ? Effect.succeed(document(authz))
    : Effect.fail(
        new NotFound({
          type: ".well-known/smart-configuration",
          id: config.transport
        })
      )
