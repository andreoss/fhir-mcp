import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { createHmac, generateKeyPairSync } from "node:crypto"
import type { KeyObject } from "node:crypto"
import type { Denial } from "./failure.js"
import { status } from "./failure.js"
import type { KeySet } from "./jwk.js"
import { mint } from "./mint.js"
import { clockAt } from "./ports.js"
import { verify } from "./verify.js"
import type { Expect } from "./verify.js"

const NOW = 1_800_000_000
const ISSUER = "https://issuer.example"
const HERE = "https://fhir.example/mcp"
const THERE = "https://other.example/mcp"

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
const okp = generateKeyPairSync("ed25519")
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 })

const set: KeySet = new Map<string, KeyObject>([
  ["r1", rsa.publicKey],
  ["e1", ec.publicKey],
  ["o1", okp.publicKey]
])

const expected: Expect = { issuer: ISSUER, audience: HERE, keys: set }

const claims = (extra: Readonly<Record<string, unknown>> = {}) => ({
  iss: ISSUER,
  sub: "practitioner-7",
  aud: HERE,
  exp: NOW + 300,
  scope: "user/Patient.read user/Observation.read",
  ...extra
})

const run = (token: string, expect: Expect = expected, seconds = NOW) =>
  Effect.runSyncExit(Effect.provide(verify(token, expect), clockAt(seconds)))

const value = <A>(exit: Exit.Exit<A, Denial>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a value, got ${JSON.stringify(exit)}`)
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")

describe("token signature, SEC-08", () => {
  it("accepts an asymmetric signature made with a key the issuer published", () => {
    const verified = value(run(mint(claims(), { alg: "RS256", key: rsa.privateKey, kid: "r1" })))
    expect(verified.sub).toBe("practitioner-7")
    expect(verified.iss).toBe(ISSUER)
    expect(verified.scope).toEqual(["user/Patient.read", "user/Observation.read"])
  })

  it("accepts every asymmetric family it offers", () => {
    expect(value(run(mint(claims(), { alg: "PS256", key: rsa.privateKey, kid: "r1" }))).sub).toBe("practitioner-7")
    expect(value(run(mint(claims(), { alg: "RS512", key: rsa.privateKey, kid: "r1" }))).sub).toBe("practitioner-7")
    expect(value(run(mint(claims(), { alg: "ES256", key: ec.privateKey, kid: "e1" }))).sub).toBe("practitioner-7")
    expect(value(run(mint(claims(), { alg: "EdDSA", key: okp.privateKey, kid: "o1" }))).sub).toBe("practitioner-7")
  })

  it("refuses a symmetric algorithm", () => {
    const head = part({ alg: "HS256", typ: "JWT", kid: "r1" })
    const body = part(claims())
    const seal = createHmac("sha256", "shared-secret").update(`${head}.${body}`).digest("base64url")
    const refusal = denial(run(`${head}.${body}.${seal}`))
    expect(status(refusal)).toBe(401)
    expect(refusal._tag).toBe("Unauthorized")
  })

  it("refuses the none algorithm", () => {
    const token = `${part({ alg: "none", typ: "JWT" })}.${part(claims())}.`
    expect(status(denial(run(token)))).toBe(401)
  })

  it("refuses an algorithm it does not offer", () => {
    const token = `${part({ alg: "XX256", kid: "r1" })}.${part(claims())}.c2ln`
    expect(status(denial(run(token)))).toBe(401)
  })

  it("refuses a signature made with another key", () => {
    const token = mint(claims(), { alg: "RS256", key: stranger.privateKey, kid: "r1" })
    expect(status(denial(run(token)))).toBe(401)
  })

  it("refuses a token whose key identifier names no published key", () => {
    const token = mint(claims(), { alg: "RS256", key: rsa.privateKey, kid: "unknown" })
    expect(status(denial(run(token)))).toBe(401)
  })

  it("accepts a token with no key identifier when the issuer published one key", () => {
    const only: KeySet = new Map([["r1", rsa.publicKey]])
    const token = mint(claims(), { alg: "RS256", key: rsa.privateKey })
    expect(value(run(token, { ...expected, keys: only })).sub).toBe("practitioner-7")
  })

  it("refuses a token with no key identifier when the issuer published several", () => {
    expect(status(denial(run(mint(claims(), { alg: "RS256", key: rsa.privateKey }))))).toBe(401)
  })
})

describe("token audience, MCPA-05", () => {
  it("refuses a token minted for another audience though its signature is good", () => {
    const token = mint(claims({ aud: THERE }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(value(run(token, { ...expected, audience: THERE })).aud).toEqual([THERE])
    const refusal = denial(run(token))
    expect(status(refusal)).toBe(401)
    expect(refusal._tag).toBe("Unauthorized")
  })

  it("accepts a token whose audience list names this resource", () => {
    const token = mint(claims({ aud: [THERE, HERE] }), { alg: "ES256", key: ec.privateKey, kid: "e1" })
    expect(value(run(token)).aud).toEqual([THERE, HERE])
  })

  it("refuses a token whose audience list does not name this resource", () => {
    const token = mint(claims({ aud: [THERE] }), { alg: "ES256", key: ec.privateKey, kid: "e1" })
    expect(status(denial(run(token)))).toBe(401)
  })

  it("refuses a token that binds no audience at all", () => {
    const token = mint(claims({ aud: undefined }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(status(denial(run(token)))).toBe(401)
  })

  it("refuses a token minted by another issuer", () => {
    const token = mint(claims({ iss: "https://elsewhere.example" }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(status(denial(run(token)))).toBe(401)
  })
})

describe("token lifetime, MCPA-02", () => {
  it("refuses an expired token with 401", () => {
    const token = mint(claims({ exp: NOW - 1 }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(status(denial(run(token)))).toBe(401)
  })

  it("accepts a token that expired inside the allowed drift", () => {
    const token = mint(claims({ exp: NOW - 20 }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(value(run(token, { ...expected, leeway: 30 })).sub).toBe("practitioner-7")
  })

  it("refuses a token that is not yet valid", () => {
    const token = mint(claims({ nbf: NOW + 60 }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(status(denial(run(token)))).toBe(401)
  })

  it("accepts a token once its not-before has passed", () => {
    const token = mint(claims({ nbf: NOW - 60 }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(value(run(token)).nbf).toBe(NOW - 60)
  })
})

describe("token shape", () => {
  it("refuses text with the wrong number of parts with 400", () => {
    expect(status(denial(run("abc.def")))).toBe(400)
    expect(status(denial(run("")))).toBe(400)
  })

  it("refuses a header that cannot be read", () => {
    expect(status(denial(run(`!!!.${part(claims())}.c2ln`)))).toBe(400)
  })

  it("refuses a header that is not the shape a token has", () => {
    expect(status(denial(run(`${part({ typ: "JWT" })}.${part(claims())}.c2ln`)))).toBe(400)
  })

  it("refuses a payload that cannot be read", () => {
    const head = part({ alg: "RS256", kid: "r1" })
    expect(status(denial(run(`${head}.!!!.c2ln`)))).toBe(400)
  })

  it("refuses a payload missing the claims it must carry", () => {
    const token = mint({ iss: ISSUER, aud: HERE }, { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(status(denial(run(token)))).toBe(400)
  })

  it("reads a token that carries no scope as one that grants nothing", () => {
    const token = mint(claims({ scope: undefined }), { alg: "RS256", key: rsa.privateKey, kid: "r1" })
    expect(value(run(token)).scope).toEqual([])
  })
})
