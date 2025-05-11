import { Effect } from "effect"
import type { Criteria, Version, VersionedStore } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { Gone, NotFound, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Reader } from "./incumbent.js"

export type Request =
  | { readonly kind: "read"; readonly type: string; readonly id: string }
  | { readonly kind: "search"; readonly type: string; readonly criteria: Criteria }

export type Answer =
  | { readonly of: "resource"; readonly body: FhirResource }
  | { readonly of: "set"; readonly total: number; readonly id: ReadonlyArray<string> }
  | { readonly of: "failure"; readonly tag: string; readonly detail: string }

export interface Side {
  readonly name: string
  readonly serve: (request: Request) => Effect.Effect<Answer>
}

export interface Pair {
  readonly request: Request
  readonly left: Answer
  readonly right: Answer
}

export interface Run {
  readonly left: string
  readonly right: string
  readonly pair: ReadonlyArray<Pair>
}

export const refused = (failure: Failure): Answer => ({
  of: "failure",
  tag: failure._tag,
  detail: toOutcome(failure).issue[0]?.diagnostics ?? "no reason given"
})

const one = (reader: Reader, type: string, id: string): Effect.Effect<Answer, Failure> =>
  Effect.gen(function* () {
    const found = yield* reader.read(type, id)
    if (found === undefined) return yield* Effect.fail(new NotFound({ type, id }))
    if (found.deleted) return yield* Effect.fail(new Gone({ type, id }))
    return { of: "resource", body: found.body } satisfies Answer
  })

const many = (found: ReadonlyArray<Version>): Answer => ({
  of: "set",
  total: found.length,
  id: [...found.map((entry) => entry.id)].sort()
})

export const readerOf = (store: VersionedStore): Reader => ({
  read: (type, id) => store.current(type, id),
  matching: (type, criteria) => store.matching(type, criteria)
})

export const side = (name: string, reader: Reader): Side => ({
  name,
  serve: (request) =>
    (request.kind === "read"
      ? one(reader, request.type, request.id)
      : Effect.map(reader.matching(request.type, request.criteria), many)
    ).pipe(Effect.catchAll((failure) => Effect.succeed(refused(failure))))
})

export const shadow = (
  left: Side,
  right: Side,
  request: ReadonlyArray<Request>
): Effect.Effect<Run> =>
  Effect.map(
    Effect.forEach(request, (asked) =>
      Effect.map(Effect.all([left.serve(asked), right.serve(asked)]), ([a, b]) => ({
        request: asked,
        left: a,
        right: b
      }))
    ),
    (pair) => ({ left: left.name, right: right.name, pair })
  )
