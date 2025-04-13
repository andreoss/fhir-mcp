import { verify as checked } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { Effect, Schema } from "effect"
import { Rejected } from "../core/outcome.js"
import { SYMMETRIC, named, options } from "./algs.js"
import { Unauthorized } from "./failure.js"
import type { Denial } from "./failure.js"
import type { KeySet } from "./jwk.js"
import { Clock } from "./ports.js"

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optional(Schema.String)
})

const Payload = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  jti: Schema.optional(Schema.String),
  sid: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  client_id: Schema.optional(Schema.String)
})

export interface Claims {
  readonly iss: string
  readonly sub: string
  readonly aud: ReadonlyArray<string>
  readonly exp: number
  readonly nbf: number | undefined
  readonly jti: string | undefined
  readonly sid: string | undefined
  readonly scope: ReadonlyArray<string>
  readonly client: string | undefined
}

export interface Expect {
  readonly issuer: string
  readonly audience: string
  readonly keys: KeySet
  readonly leeway?: number | undefined
}

const refuse = (reason: string) => Effect.fail(new Unauthorized({ reason }))

const read = <A, I>(schema: Schema.Schema<A, I>, raw: string, what: string) =>
  Effect.try({
    try: () => JSON.parse(Buffer.from(raw, "base64url").toString()) as unknown,
    catch: () => new Rejected({ reason: `the token ${what} could not be read` })
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknown(schema)(parsed).pipe(
        Effect.mapError(() => new Rejected({ reason: `the token ${what} is malformed` }))
      )
    )
  )

const keyOf = (keys: KeySet, kid: string | undefined): Effect.Effect<KeyObject, Denial> => {
  if (kid !== undefined) {
    const found = keys.get(kid)
    return found === undefined
      ? refuse("no published key matches the token")
      : Effect.succeed(found)
  }
  const only = keys.size === 1 ? [...keys.values()][0] : undefined
  return only === undefined
    ? refuse("the token names no published key")
    : Effect.succeed(only)
}

const audienceOf = (aud: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  aud === undefined ? [] : typeof aud === "string" ? [aud] : aud

export const verify = (token: string, expect: Expect): Effect.Effect<Claims, Denial, Clock> =>
  Effect.gen(function* () {
    const parts = token.split(".")
    const head = parts[0]
    const body = parts[1]
    const seal = parts[2]
    if (parts.length !== 3 || head === undefined || body === undefined || seal === undefined) {
      return yield* Effect.fail(new Rejected({ reason: "the token is malformed" }))
    }
    const header = yield* read(Header, head, "header")
    const payload = yield* read(Payload, body, "payload")
    if (header.alg === "none") {
      return yield* refuse("the none algorithm is refused")
    }
    if (SYMMETRIC.has(header.alg)) {
      return yield* refuse("a symmetric algorithm is refused")
    }
    const spec = named(header.alg)
    if (spec === undefined) {
      return yield* Effect.fail(new Unauthorized({ reason: `algorithm not accepted: ${header.alg}` }))
    }
    const key = yield* keyOf(expect.keys, header.kid)
    const signed = yield* Effect.try({
      try: () =>
        checked(
          spec.hash,
          Buffer.from(`${head}.${body}`),
          options(spec, key),
          Buffer.from(seal, "base64url")
        ),
      catch: () => new Unauthorized({ reason: "the signature was not accepted" })
    })
    if (!signed) {
      return yield* refuse("the signature was not accepted")
    }
    if (payload.iss !== expect.issuer) {
      return yield* refuse("the token is from another issuer")
    }
    const aud = audienceOf(payload.aud)
    if (!aud.includes(expect.audience)) {
      return yield* refuse("the token is bound to another audience")
    }
    const clock = yield* Clock
    const now = clock.seconds()
    const leeway = expect.leeway ?? 0
    if (payload.exp + leeway < now) {
      return yield* refuse("the token has expired")
    }
    if (payload.nbf !== undefined && payload.nbf - leeway > now) {
      return yield* refuse("the token is not yet valid")
    }
    return {
      iss: payload.iss,
      sub: payload.sub,
      aud,
      exp: payload.exp,
      nbf: payload.nbf,
      jti: payload.jti,
      sid: payload.sid,
      scope: payload.scope === undefined
        ? []
        : payload.scope.split(" ").filter((name) => name.length > 0),
      client: payload.client_id
    }
  })
