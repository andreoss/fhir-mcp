import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Denial } from "./failure.js"

const SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/

export const METHOD = "S256" as const

export const verifier = (): string => randomBytes(32).toString("base64url")

export const challenge = (secret: string): string =>
  createHash("sha256").update(secret).digest("base64url")

export const prove = (
  secret: string,
  challenged: string,
  method: string
): Effect.Effect<void, Denial> => {
  if (method !== METHOD) {
    return Effect.fail(new Rejected({ reason: `the proof key method must be ${METHOD}` }))
  }
  if (!SHAPE.test(secret)) {
    return Effect.fail(new Rejected({ reason: "the proof key verifier is malformed" }))
  }
  const given = Buffer.from(challenged)
  const wanted = Buffer.from(challenge(secret))
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return Effect.fail(new Rejected({ reason: "the proof key verifier does not match" }))
  }
  return Effect.void
}
