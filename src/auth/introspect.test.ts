import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { generateKeyPairSync } from "node:crypto"
import type { KeySet } from "./jwk.js"
import { introspect } from "./introspect.js"
import { mint } from "./mint.js"
import { clockAt } from "./ports.js"
import type { Expect } from "./verify.js"

const NOW = 1_800_000_000
const ISSUER = "https://issuer.example"
const HERE = "https://fhir.example/mcp"

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const keys: KeySet = new Map([["r1", rsa.publicKey]])
const expected: Expect = { issuer: ISSUER, audience: HERE, keys }

const token = (extra: Readonly<Record<string, unknown>> = {}) =>
  mint(
    {
      iss: ISSUER,
      sub: "practitioner-7",
      aud: HERE,
      exp: NOW + 300,
      scope: "user/Patient.read",
      client_id: "clinic-desktop",
      ...extra
    },
    { alg: "RS256", key: rsa.privateKey, kid: "r1" }
  )

const ask = (presented: string, seconds = NOW) =>
  Effect.runSync(Effect.provide(introspect(presented, expected), clockAt(seconds)))

describe("token introspection, SEC-05", () => {
  it("reports an active token with what it was granted", () => {
    const reported = ask(token())
    expect(reported.active).toBe(true)
    if (!reported.active) throw new Error("expected an active token")
    expect(reported.sub).toBe("practitioner-7")
    expect(reported.iss).toBe(ISSUER)
    expect(reported.aud).toEqual([HERE])
    expect(reported.scope).toBe("user/Patient.read")
    expect(reported.exp).toBe(NOW + 300)
    expect(reported.client_id).toBe("clinic-desktop")
  })

  it("reports inactive for an expired token and says nothing more", () => {
    const reported = ask(token(), NOW + 301)
    expect(reported).toEqual({ active: false })
  })

  it("reports inactive for a token minted for another audience", () => {
    expect(ask(token({ aud: "https://other.example/mcp" }))).toEqual({ active: false })
  })

  it("reports inactive for text that is not a token", () => {
    expect(ask("not-a-token")).toEqual({ active: false })
    expect(ask("")).toEqual({ active: false })
  })

  it("never echoes the token it was asked about", () => {
    const presented = token()
    expect(JSON.stringify(ask(presented))).not.toContain(presented)
    expect(JSON.stringify(ask(presented))).not.toContain(presented.split(".")[2])
  })
})
