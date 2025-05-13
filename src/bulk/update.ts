import { Effect, Either } from "effect"
import { Rules, Versions, defaults, patch } from "../core/interactions.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Handler, Unit } from "../jobs/types.js"
import type { Versioned } from "../store/versioned.js"
import type { Depot, Item } from "./depot.js"
import { MendDoc, RewriteDoc, chunked, decoded, typesOf, why } from "./spec.js"

const KINDS = ["json", "fhirpath"]

const shaped = (doc: unknown): Effect.Effect<void, Failure> => {
  const held = doc as { kind?: unknown; ops?: unknown }
  const known =
    typeof held === "object" &&
    held !== null &&
    KINDS.some((one) => one === held.kind) &&
    Array.isArray(held.ops)
  return known
    ? Effect.void
    : Effect.fail(new Rejected({ reason: "patch is not a patch document" }))
}

export const updater = (store: Versioned, depot: Depot): Handler => {
  const split = (request: string) =>
    Effect.gen(function* () {
      const ask = yield* decoded(RewriteDoc, "bulk-update", request)
      yield* shaped(ask.patch)
      const chosen = yield* typesOf(
        ask.type === undefined ? undefined : [ask.type]
      )
      const cuts: Array<string> = []
      for (const type of chosen) {
        const found = yield* store.matching(type, ask.criteria ?? [])
        const parts = chunked(
          found.map((one) => one.id),
          ask.chunk
        )
        const held = parts.length === 0 ? [[] as ReadonlyArray<string>] : parts
        for (const ids of held) {
          cuts.push(JSON.stringify({ type, ids, patch: ask.patch }))
        }
      }
      return cuts
    })

  const run = (unit: Unit) =>
    Effect.gen(function* () {
      const mend = yield* decoded(MendDoc, "bulk-update unit", unit.payload)
      yield* depot.note({
        job: unit.jobId,
        kind: unit.kind,
        container: mend.type,
        location: undefined,
        etag: undefined,
        detail: "bulk update"
      })
      const items: Array<Item> = []
      let written = 0
      let skipped = 0
      for (const id of mend.ids) {
        const done = yield* Effect.either(
          patch(mend.type, id, mend.patch).pipe(
            Effect.provideService(Versions, store),
            Effect.provideService(Rules, defaults)
          )
        )
        if (Either.isLeft(done)) {
          items.push({
            type: mend.type,
            id,
            line: undefined,
            reason: why(done.left)
          })
        } else if (done.right.changed) written = written + 1
        else skipped = skipped + 1
      }
      yield* depot.fault(unit.jobId, unit.unitId, items)
      yield* depot.mark({
        job: unit.jobId,
        unit: unit.unitId,
        type: mend.type,
        path: undefined,
        written,
        skipped,
        failed: items.length,
        scanned: mend.ids.length
      })
    })

  return { split, run }
}
