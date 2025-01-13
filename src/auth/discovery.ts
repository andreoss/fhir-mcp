import type { KeyObject } from "node:crypto"
import { Effect, Schema } from "effect"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Denial } from "./failure.js"
import { symmetric, thumbprint, toKey } from "./jwk.js"
import type { KeySet } from "./jwk.js"
import { METHOD } from "./pkce.js"
import { Net } from "./ports.js"
import type { Answer } from "./ports.js"

export const WELL_KNOWN = "/.well-known/oauth-authorization-server"

export interface Pin {
  readonly issuer: string
  readonly thumbprints: ReadonlyArray<string>
}

export interface Metadata {
  readonly issuer: string
  readonly authorization: string
  readonly token: string
  readonly registration: string | undefined
  readonly jwks: string | undefined
  readonly methods: ReadonlyArray<string>
}

const Document = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  jwks_uri: Schema.optional(Schema.String),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String))
})

const Published = Schema.Struct({
  keys: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})

const refuse = (reason: string) => Effect.fail(new Rejected({ reason }))

export const origin = (address: string): Effect.Effect<string, Denial> =>
  Effect.try({
    try: () => new URL(address),
    catch: () => new Rejected({ reason: `not an address: ${address}` })
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === "https:"
        ? Effect.succeed(url.origin)
        : refuse(`a plain address is refused: ${address}`)
    )
  )

const answered = (answer: Answer, from: string, what: string): Effect.Effect<void, Denial> =>
  origin(answer.url).pipe(
    Effect.flatMap((got) =>
      got === from ? Effect.void : refuse(`${what} was answered from ${got}`)
    )
  )

const decode = <A, I>(schema: Schema.Schema<A, I>, body: unknown, what: string) =>
  Schema.decodeUnknown(schema)(body).pipe(
    Effect.mapError(() => new Rejected({ reason: `${what} is malformed` }))
  )

const fallback = (base: string): Metadata => ({
  issuer: base,
  authorization: `${base}/authorize`,
  token: `${base}/token`,
  registration: `${base}/register`,
  jwks: undefined,
  methods: [METHOD]
})

const pinned = (metadata: Metadata, pin: Pin): Effect.Effect<Metadata, Denial> =>
  Effect.gen(function* () {
    if (metadata.issuer !== pin.issuer) {
      return yield* refuse(`the issuer is not the pinned one: ${metadata.issuer}`)
    }
    const addresses = [
      metadata.authorization,
      metadata.token,
      ...(metadata.registration === undefined ? [] : [metadata.registration]),
      ...(metadata.jwks === undefined ? [] : [metadata.jwks])
    ]
    for (const address of addresses) yield* origin(address)
    return metadata
  })

export const discover = (server: string, pin: Pin): Effect.Effect<Metadata, Denial, Net> =>
  Effect.gen(function* () {
    const base = yield* origin(server)
    const net = yield* Net
    const answer = yield* net.get(`${base}${WELL_KNOWN}`)
    if (answer.status === 404) return yield* pinned(fallback(base), pin)
    if (answer.status !== 200) {
      return yield* Effect.fail(new Unavailable({ dependency: "issuer metadata" }))
    }
    yield* answered(answer, base, "the issuer metadata")
    const document = yield* decode(Document, answer.body, "the issuer metadata")
    const methods = document.code_challenge_methods_supported ?? []
    if (!methods.includes(METHOD)) {
      return yield* refuse(`the issuer does not offer the ${METHOD} proof key method`)
    }
    return yield* pinned(
      {
        issuer: document.issuer,
        authorization: document.authorization_endpoint,
        token: document.token_endpoint,
        registration: document.registration_endpoint,
        jwks: document.jwks_uri,
        methods
      },
      pin
    )
  })

export const keys = (metadata: Metadata, pin: Pin): Effect.Effect<KeySet, Denial, Net> =>
  Effect.gen(function* () {
    const address = metadata.jwks
    if (address === undefined) return yield* refuse("the issuer publishes no key set")
    const at = yield* origin(address)
    if (at !== pin.issuer) return yield* refuse(`the key set is served from ${at}`)
    const net = yield* Net
    const answer = yield* net.get(address)
    if (answer.status !== 200) {
      return yield* Effect.fail(new Unavailable({ dependency: "issuer key set" }))
    }
    yield* answered(answer, at, "the key set")
    const document = yield* decode(Published, answer.body, "the key set")
    if (document.keys.length === 0) return yield* refuse("the issuer published no key")
    const held = new Map<string, KeyObject>()
    for (const jwk of document.keys) {
      if (symmetric(jwk)) return yield* refuse("the issuer offered a symmetric key")
      const printed = yield* thumbprint(jwk)
      if (!pin.thumbprints.includes(printed)) {
        return yield* refuse("the issuer offered a key that was not pinned")
      }
      const key = yield* toKey(jwk)
      const kid = jwk["kid"]
      held.set(typeof kid === "string" ? kid : printed, key)
    }
    return held
  })
