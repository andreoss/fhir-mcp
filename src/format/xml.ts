import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { FhirResource } from "../core/engine.js"
import { toObject, toTree } from "./convert.js"
import type { Find } from "./convert.js"
import { lookup } from "./defs.js"
import { LIMITS, isFault, render, scan, write } from "./tree.js"
import type { Fault, Limits } from "./tree.js"

export interface Opts {
  readonly find?: Find
  readonly limits?: Partial<Limits>
}

const refuse = (held: Fault): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason: render(held) }))

export const parse = (
  document: string,
  opts: Opts = {}
): Effect.Effect<FhirResource, Failure> =>
  Effect.suspend(() => {
    const limits: Limits = { ...LIMITS, ...opts.limits }
    const root = scan(document, limits)
    if (isFault(root)) return refuse(root)
    const held = toObject(root, opts.find ?? lookup, limits)
    return isFault(held)
      ? refuse(held)
      : Effect.succeed(held as unknown as FhirResource)
  })

export const serialize = (
  body: unknown,
  opts: Opts = {}
): Effect.Effect<string, Failure> =>
  Effect.suspend(() => {
    const limits: Limits = { ...LIMITS, ...opts.limits }
    const root = toTree(body, opts.find ?? lookup, limits)
    return isFault(root) ? refuse(root) : Effect.succeed(write(root))
  })
