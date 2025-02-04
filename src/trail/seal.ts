import { createHmac, timingSafeEqual } from "node:crypto"

export interface Seal {
  readonly seq: number
  readonly digest: string
  readonly at: number
  readonly mac: string
}

export interface Anchor {
  readonly seq: number
  readonly prev: string
  readonly through: number
  readonly mac: string
}

const tag = (key: string, value: string): string =>
  createHmac("sha256", key).update(value).digest("hex")

const alike = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

const sealed = (seq: number, digest: string, at: number): string =>
  `seal|${seq}|${digest}|${at}`

const anchored = (seq: number, prev: string, through: number): string =>
  `anchor|${seq}|${prev}|${through}`

export const sealOf = (
  key: string,
  seq: number,
  digest: string,
  at: number
): Seal => ({ seq, digest, at, mac: tag(key, sealed(seq, digest, at)) })

export const anchorOf = (
  key: string,
  seq: number,
  prev: string,
  through: number
): Anchor => ({
  seq,
  prev,
  through,
  mac: tag(key, anchored(seq, prev, through))
})

export const holds = (key: string, seal: Seal): boolean =>
  alike(seal.mac, tag(key, sealed(seal.seq, seal.digest, seal.at)))

export const pins = (key: string, anchor: Anchor): boolean =>
  alike(anchor.mac, tag(key, anchored(anchor.seq, anchor.prev, anchor.through)))
