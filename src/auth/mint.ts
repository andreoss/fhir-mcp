import { sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { ALGS, options } from "./algs.js"
import type { AlgName } from "./algs.js"

export interface Signer {
  readonly alg: AlgName
  readonly key: KeyObject
  readonly kid?: string | undefined
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")

export const mint = (claims: Readonly<Record<string, unknown>>, signer: Signer): string => {
  const spec = ALGS[signer.alg]
  const header = {
    alg: signer.alg,
    typ: "JWT",
    ...(signer.kid === undefined ? {} : { kid: signer.kid })
  }
  const body = `${part(header)}.${part(claims)}`
  const seal = sign(spec.hash, Buffer.from(body), options(spec, signer.key))
  return `${body}.${seal.toString("base64url")}`
}
