import { createHash, createPublicKey } from "node:crypto"
import type { KeyObject, webcrypto } from "node:crypto"
import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Denial } from "./failure.js"

export type Jwk = Readonly<Record<string, unknown>>

export type KeySet = ReadonlyMap<string, KeyObject>

const MEMBERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  RSA: ["e", "kty", "n"],
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"]
}

const refuse = (reason: string) => Effect.fail(new Rejected({ reason }))

export const symmetric = (jwk: Jwk): boolean => {
  const alg = jwk["alg"]
  return jwk["kty"] === "oct" || (typeof alg === "string" && alg.startsWith("HS"))
}

export const thumbprint = (jwk: Jwk): Effect.Effect<string, Denial> => {
  if (symmetric(jwk)) return refuse("a symmetric key is not accepted")
  const kind = jwk["kty"]
  const members = typeof kind === "string" ? MEMBERS[kind] : undefined
  if (members === undefined) return refuse(`published key kind not accepted: ${String(kind)}`)
  const canonical: Record<string, string> = {}
  for (const member of members) {
    const value = jwk[member]
    if (typeof value !== "string") return refuse(`the published key is missing ${member}`)
    canonical[member] = value
  }
  return Effect.succeed(createHash("sha256").update(JSON.stringify(canonical)).digest("base64url"))
}

export const toKey = (jwk: Jwk): Effect.Effect<KeyObject, Denial> =>
  symmetric(jwk)
    ? refuse("a symmetric key is not accepted")
    : Effect.try({
      try: () => createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: "jwk" }),
      catch: () => new Rejected({ reason: "the published key could not be read" })
    })
