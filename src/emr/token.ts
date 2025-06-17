import { Data, Context, Effect, Layer } from "effect"
import { randomBytes } from "node:crypto"
import type { Failure } from "../core/outcome.js"
import { jsonOf } from "./wire.js"
import type { Answer } from "./wire.js"

export interface AssertionSigner {
  readonly kid: string
  readonly sign: (claims: Readonly<Record<string, unknown>>) => string
}

export interface IssuerConfig {
  readonly tokenUrl: string
  readonly clientId: string
  readonly kid: string
  readonly assertionLifetimeMs: number
  readonly refreshMarginMs: number
  readonly scope?: string
}

export interface TokenResponse {
  readonly accessToken: string
  readonly tokenType: string
  readonly expiresAt: number
}

export interface SignedAssertion {
  readonly assertion: string
  readonly aud: string
  readonly exp: number
}

export class Denied extends Data.TaggedError("Denied")<{ readonly reason: string }> {}
export class AudienceMismatch extends Data.TaggedError("AudienceMismatch")<{ readonly reason: string }> {}
export class Replayed extends Data.TaggedError("Replayed")<{ readonly reason: string }> {}
export class Expired extends Data.TaggedError("Expired")<{ readonly reason: string }> {}

export type TokenFailure = Failure | Denied | AudienceMismatch | Replayed | Expired

export interface Time {
  readonly ms: () => number
}

export class TokenClock extends Context.Tag("emr/TokenClock")<TokenClock, Time>() {}

export const systemTokenClock: Layer.Layer<TokenClock> = Layer.succeed(TokenClock, {
  ms: () => Date.now()
})

export const tokenClockAt = (ms: number): Layer.Layer<TokenClock> =>
  Layer.succeed(TokenClock, { ms: () => ms })

export interface Post {
  readonly post: (url: string, body: string) => Effect.Effect<Answer, Failure>
}

export class TokenNet extends Context.Tag("emr/TokenNet")<TokenNet, Post>() {}

export interface Held {
  readonly refreshMarginMs: number
  readonly issued: () => ReadonlyArray<string>
  readonly assert: (now: number) => SignedAssertion
  readonly store: (token: TokenResponse) => void
  readonly current: (now: number) => TokenResponse | undefined
  readonly grant: () => TokenResponse | undefined
  readonly invalidate: () => void
}

export const cache = (cfg: IssuerConfig, signer: AssertionSigner): Held => {
  let current: TokenResponse | undefined
  const seen: Set<string> = new Set()

  const assert = (now: number): SignedAssertion => {
    let jti = randomBytes(16).toString("base64url")
    while (seen.has(jti)) jti = randomBytes(16).toString("base64url")
    seen.add(jti)
    const exp = now + cfg.assertionLifetimeMs
    return {
      assertion: signer.sign({
        iss: cfg.clientId,
        sub: cfg.clientId,
        aud: cfg.tokenUrl,
        exp: Math.floor(exp / 1000),
        iat: Math.floor(now / 1000),
        jti,
        ...(cfg.scope !== undefined && cfg.scope.length > 0 ? { scope: cfg.scope } : {})
      }),
      aud: cfg.tokenUrl,
      exp
    }
  }

  const store = (token: TokenResponse) => {
    current = token
  }

  const currentOf = (now: number): TokenResponse | undefined => {
    if (current === undefined) return undefined
    if (current.expiresAt * 1000 - cfg.refreshMarginMs <= now) return undefined
    return current
  }

  return {
    refreshMarginMs: cfg.refreshMarginMs,
    issued: () => [...seen],
    assert,
    store,
    current: currentOf,
    grant: () => current,
    invalidate: () => {
      current = undefined
    }
  }
}

export const exchange = (
  cfg: IssuerConfig,
  signer: AssertionSigner,
  held: Held,
  force = false
): Effect.Effect<TokenResponse, TokenFailure, TokenClock | TokenNet> =>
  Effect.gen(function* () {
    const clock = yield* TokenClock
    const net = yield* TokenNet
    const now = clock.ms()
    const cached = held.current(now)
    if (!force && cached !== undefined) return cached
    if (signer.kid !== cfg.kid) {
      return yield* Effect.fail(new AudienceMismatch({ reason: "the assertion kid does not match the configured kid" }))
    }
    const signed = held.assert(now)
    if (signed.aud !== cfg.tokenUrl) {
      return yield* Effect.fail(new AudienceMismatch({ reason: "the assertion audience does not match the token endpoint" }))
    }
    if (signed.exp <= now) {
      return yield* Effect.fail(new Expired({ reason: "the assertion lifetime elapsed before the exchange" }))
    }
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: signed.assertion
    })
    if (cfg.scope !== undefined && cfg.scope.length > 0) params.set("scope", cfg.scope)
    const answer = yield* net.post(cfg.tokenUrl, params.toString())
    const doc = jsonOf(answer.body)
    if (answer.status !== 200 || doc === undefined || typeof doc["access_token"] !== "string") {
      return yield* Effect.fail(new Denied({ reason: "the token endpoint refused the exchange" }))
    }
    const token: TokenResponse = {
      accessToken: doc["access_token"],
      tokenType: typeof doc["token_type"] === "string" ? doc["token_type"] : "Bearer",
      expiresAt: Math.floor(clock.ms() / 1000) + (typeof doc["expires_in"] === "number" ? doc["expires_in"] : 3600)
    }
    held.store(token)
    return token
  })