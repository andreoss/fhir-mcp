import { Effect, Either } from "effect"
import { Versions, remove } from "../core/interactions.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Handler, Unit } from "../jobs/types.js"
import type { Versioned } from "../store/versioned.js"
import type { Depot, Item } from "./depot.js"
import { DropDoc, PurgeDoc, chunked, decoded, typesOf, why } from "./spec.js"

export const deleter = (store: Versioned, depot: Depot): Handler => {
  const chosen = (
    type: string,
    criteria: ReadonlyArray<readonly [string, string]>,
    softDeleted: boolean
  ): Effect.Effect<ReadonlyArray<string>, Failure> => {
    if (!softDeleted) {
      return Effect.map(store.matching(type, criteria), (found) =>
        found.map((one) => one.id)
      )
    }
    return criteria.length > 0
      ? Effect.fail(
          new Rejected({
            reason: "criteria do not reach the already soft deleted"
          })
        )
      : depot.ids(type, true)
  }

  const split = (request: string) =>
    Effect.gen(function* () {
      const ask = yield* decoded(PurgeDoc, "bulk-delete", request)
      yield* typesOf([ask.type])
      const most = ask._maxCount
      if (most !== undefined && (!Number.isInteger(most) || most < 1)) {
        return yield* Effect.fail(
          new Rejected({ reason: `_maxCount is not a count: ${most}` })
        )
      }
      const softDeleted = ask.softDeleted === true
      const found = yield* chosen(ask.type, ask.criteria ?? [], softDeleted)
      const excluded = new Set(ask.exclude ?? [])
      const kept = found.filter((id) => !excluded.has(id))
      const ids = most === undefined ? kept : kept.slice(0, most)
      const mode = softDeleted ? "hard" : ask.mode ?? "soft"
      const parts = chunked(ids, ask.chunk)
      const cuts = parts.length === 0 ? [[] as ReadonlyArray<string>] : parts
      return cuts.map((part) =>
        JSON.stringify({ type: ask.type, ids: part, mode })
      )
    })

  const run = (unit: Unit) =>
    Effect.gen(function* () {
      const drop = yield* decoded(DropDoc, "bulk-delete unit", unit.payload)
      yield* depot.note({
        job: unit.jobId,
        kind: unit.kind,
        container: drop.type,
        location: undefined,
        etag: undefined,
        detail: `${drop.mode} bulk delete`
      })
      const items: Array<Item> = []
      let written = 0
      let skipped = 0
      for (const id of drop.ids) {
        const gone = yield* Effect.either(
          remove(drop.type, id, drop.mode).pipe(
            Effect.provideService(Versions, store)
          )
        )
        if (Either.isLeft(gone)) {
          items.push({
            type: drop.type,
            id,
            line: undefined,
            reason: why(gone.left)
          })
        } else if (gone.right.changed) written = written + 1
        else skipped = skipped + 1
      }
      yield* depot.fault(unit.jobId, unit.unitId, items)
      yield* depot.mark({
        job: unit.jobId,
        unit: unit.unitId,
        type: drop.type,
        path: undefined,
        written,
        skipped,
        failed: items.length,
        scanned: drop.ids.length
      })
    })

  return { split, run }
}
