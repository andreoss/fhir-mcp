import { constants } from "node:crypto"
import type { KeyObject, SignKeyObjectInput } from "node:crypto"

export type AlgName =
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA"

export interface Alg {
  readonly hash: string | null
  readonly padding?: number
  readonly saltLength?: number
  readonly dsaEncoding?: "ieee-p1363"
}

const pss = (hash: string): Alg => ({
  hash,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: constants.RSA_PSS_SALTLEN_DIGEST
})

export const ALGS: Readonly<Record<AlgName, Alg>> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: pss("sha256"),
  PS384: pss("sha384"),
  PS512: pss("sha512"),
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" },
  ES512: { hash: "sha512", dsaEncoding: "ieee-p1363" },
  EdDSA: { hash: null }
}

export const SYMMETRIC: ReadonlySet<string> = new Set(["HS256", "HS384", "HS512"])

export const named = (alg: string): Alg | undefined =>
  Object.hasOwn(ALGS, alg) ? ALGS[alg as AlgName] : undefined

export const options = (spec: Alg, key: KeyObject): SignKeyObjectInput => ({
  key,
  ...(spec.padding === undefined ? {} : { padding: spec.padding }),
  ...(spec.saltLength === undefined ? {} : { saltLength: spec.saltLength }),
  ...(spec.dsaEncoding === undefined ? {} : { dsaEncoding: spec.dsaEncoding })
})
