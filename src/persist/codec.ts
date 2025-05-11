import { gunzipSync, gzipSync } from "node:zlib"
import { Effect } from "effect"
import type { FhirResource } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export const LEVEL = 9

export interface Sizes {
  readonly raw: number
  readonly packed: number
}

export interface Lazy<A> {
  readonly bytes: number
  readonly parsed: () => boolean
  readonly body: Effect.Effect<A, Failure>
}

const unreadable = (): Failure =>
  new Rejected({ reason: "stored body is not readable" })

export const pack = (value: unknown): Effect.Effect<Uint8Array, Failure> =>
  Effect.try({
    try: () => gzipSync(Buffer.from(JSON.stringify(value), "utf8"), {
      level: LEVEL
    }),
    catch: unreadable
  })

export const unpack = <A = FhirResource>(
  bytes: Uint8Array
): Effect.Effect<A, Failure> =>
  Effect.try({
    try: () => JSON.parse(gunzipSync(bytes).toString("utf8")) as A,
    catch: unreadable
  })

export const measure = (value: unknown): Effect.Effect<Sizes, Failure> =>
  Effect.map(pack(value), (bytes) => ({
    raw: Buffer.byteLength(JSON.stringify(value)),
    packed: bytes.length
  }))

export const encode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64")

export const decode = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "base64"))

export const lazy = <A = FhirResource>(bytes: Uint8Array): Lazy<A> => {
  let held: A | undefined
  return {
    bytes: bytes.length,
    parsed: () => held !== undefined,
    body: Effect.suspend(() =>
      held === undefined
        ? Effect.map(unpack<A>(bytes), (value) => {
            held = value
            return value
          })
        : Effect.succeed(held)
    )
  }
}
