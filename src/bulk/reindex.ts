import { Effect } from "effect"
import { NotFound, Rejected } from "../core/outcome.js"
import type { Handler, Unit } from "../jobs/types.js"
import type { Depot, Item } from "./depot.js"
import { ReindexDoc, ScanDoc, chunked, decoded, typesOf, why } from "./spec.js"

export const reindexer = (depot: Depot): Handler => {
  const split = (request: string) =>
    Effect.gen(function* () {
      const ask = yield* decoded(ReindexDoc, "reindex", request)
      if (ask.id !== undefined && ask.type === undefined) {
        return yield* Effect.fail(
          new Rejected({ reason: "reindex of one resource names no type" })
        )
      }
      if (ask.type !== undefined) yield* typesOf([ask.type])
      const found = yield* depot.targets(
        ask.type,
        ask.id === undefined ? [] : [ask.id]
      )
      const held = new Map<string, Array<string>>()
      for (const one of found) {
        const kept = held.get(one.type)
        if (kept === undefined) held.set(one.type, [one.body.id ?? ""])
        else kept.push(one.body.id ?? "")
      }
      const cuts: Array<string> = []
      for (const [type, ids] of held) {
        for (const part of chunked(ids, ask.chunk)) {
          cuts.push(JSON.stringify({ type, ids: part }))
        }
      }
      return cuts.length === 0
        ? [JSON.stringify({ type: ask.type ?? "", ids: [] })]
        : cuts
    })

  const run = (unit: Unit) =>
    Effect.gen(function* () {
      const scan = yield* decoded(ScanDoc, "reindex unit", unit.payload)
      yield* depot.note({
        job: unit.jobId,
        kind: unit.kind,
        container: scan.type,
        location: undefined,
        etag: undefined,
        detail: "reindex"
      })
      const found = yield* depot.targets(scan.type, scan.ids)
      let written = 0
      for (const target of found) {
        written = written + (yield* depot.refresh(target))
      }
      const seen = new Set(found.map((one) => one.body.id))
      const items: Array<Item> = scan.ids
        .filter((id) => !seen.has(id))
        .map((id) => ({
          type: scan.type,
          id,
          line: undefined,
          reason: why(new NotFound({ type: scan.type, id }))
        }))
      yield* depot.fault(unit.jobId, unit.unitId, items)
      yield* depot.mark({
        job: unit.jobId,
        unit: unit.unitId,
        type: scan.type,
        path: undefined,
        written,
        skipped: 0,
        failed: items.length,
        scanned: found.length
      })
    })

  return { split, run }
}
