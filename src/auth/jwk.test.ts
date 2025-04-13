import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { generateKeyPairSync } from "node:crypto"
import type { Denial } from "./failure.js"
import { toKey, thumbprint } from "./jwk.js"
import type { Jwk } from "./jwk.js"

const value = <A>(exit: Exit.Exit<A, Denial>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected a value")
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

const published = (type: "rsa" | "ec" | "ed25519"): Jwk => {
  const pair = type === "rsa"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : type === "ec"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : generateKeyPairSync("ed25519")
  return pair.publicKey.export({ format: "jwk" }) as Jwk
}

const rsa = published("rsa")

const vector: Jwk = {
  kty: "RSA",
  n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  e: "AQAB",
  alg: "RS256",
  kid: "2011-04-29"
}

describe("published key thumbprint", () => {
  it("matches the value the standard states for its own example", () => {
    expect(value(Effect.runSyncExit(thumbprint(vector))))
      .toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs")
  })

  it("is fixed width and stable", () => {
    const one = value(Effect.runSyncExit(thumbprint(rsa)))
    expect(one).toHaveLength(43)
    expect(one).toBe(value(Effect.runSyncExit(thumbprint(rsa))))
  })

  it("ignores the order and the extra members of the document", () => {
    const plain = value(Effect.runSyncExit(thumbprint({ kty: rsa["kty"], n: rsa["n"], e: rsa["e"] })))
    const dressed = value(Effect.runSyncExit(thumbprint({ e: rsa["e"], use: "sig", kty: rsa["kty"], kid: "k1", n: rsa["n"] })))
    expect(dressed).toBe(plain)
  })

  it("differs for another key and covers the curve kinds", () => {
    const ec = value(Effect.runSyncExit(thumbprint(published("ec"))))
    const okp = value(Effect.runSyncExit(thumbprint(published("ed25519"))))
    expect(ec).not.toBe(okp)
    expect(ec).toHaveLength(43)
    expect(okp).toHaveLength(43)
  })

  it("refuses a symmetric key", () => {
    expect(denial(Effect.runSyncExit(thumbprint({ kty: "oct", k: "c2VjcmV0" })))._tag).toBe("Rejected")
  })

  it("refuses a key kind it cannot state", () => {
    expect(denial(Effect.runSyncExit(thumbprint({ kty: "UNKNOWN" })))._tag).toBe("Rejected")
  })

  it("refuses a key missing the members its kind demands", () => {
    expect(denial(Effect.runSyncExit(thumbprint({ kty: "RSA", n: "abc" })))._tag).toBe("Rejected")
  })
})

describe("published key import", () => {
  it("imports the kinds an issuer may publish", () => {
    expect(value(Effect.runSyncExit(toKey(rsa))).asymmetricKeyType).toBe("rsa")
    expect(value(Effect.runSyncExit(toKey(published("ec")))).asymmetricKeyType).toBe("ec")
    expect(value(Effect.runSyncExit(toKey(published("ed25519")))).asymmetricKeyType).toBe("ed25519")
  })

  it("refuses a symmetric key an issuer offers", () => {
    expect(denial(Effect.runSyncExit(toKey({ kty: "oct", k: "c2VjcmV0" })))._tag).toBe("Rejected")
  })

  it("refuses a key the runtime cannot read", () => {
    expect(denial(Effect.runSyncExit(toKey({ kty: "EC", crv: "P-256", x: "abc", y: "def" })))._tag).toBe("Rejected")
  })
})
