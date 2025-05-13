import { Effect } from "effect"
import type { Criteria } from "../core/interactions.js"
import { Gone, NotFound, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Handler, Unit } from "../jobs/types.js"
import type { Versioned } from "../store/versioned.js"
import type { Depot, Item } from "./depot.js"
import { apply, seal } from "./rules.js"
import type { Sealed } from "./rules.js"
import {
  CutDoc,
  ExportDoc,
  chunked,
  containerOf,
  decoded,
  filtersOf,
  formatOf,
  typesOf,
  why,
  within
} from "./spec.js"
import type { Cut, Scope } from "./spec.js"

const MEMBER: Readonly<Record<string, string>> = {
  Patient: "_id",
  Observation: "subject",
  Condition: "subject",
  Encounter: "subject"
}

const anchors = (scope: Scope, type: string): ReadonlyArray<Criteria> => {
  if (scope.kind === "system") return [[]]
  const name = MEMBER[type]
  if (name === undefined) return []
  return scope.ids.map((id) => [
    [name, name === "_id" ? id : `Patient/${id}`] as const
  ])
}

const fileOf = (job: string, cut: Cut): string =>
  `${cut.container}/${job}/${cut.type}-${cut.seq}.ndjson`

export const exporter = (store: Versioned, depot: Depot): Handler => {
  const split = (request: string) =>
    Effect.gen(function* () {
      const ask = yield* decoded(ExportDoc, "export", request)
      const format = yield* formatOf(ask._outputFormat)
      const container = yield* containerOf(ask._container)
      const chosen = yield* typesOf(ask._type)
      const filters = yield* filtersOf(ask._typeFilter)
      const stray = filters
        .map((one) => one.type)
        .filter((type) => !chosen.some((one) => one === type))
      if (stray.length > 0) {
        return yield* Effect.fail(
          new Rejected({
            reason: `type filter is outside the selection: ${stray.join(", ")}`
          })
        )
      }
      const rules =
        ask.rules === undefined
          ? undefined
          : seal(ask.rules.location, ask.rules.rules)
      const cuts: Array<string> = []
      for (const type of chosen) {
        const own = filters.filter((one) => one.type === type)
        const queries: ReadonlyArray<Criteria> =
          own.length === 0 ? [[]] : own.map((one) => one.criteria)
        const found = new Set<string>()
        for (const extra of anchors(ask.scope, type)) {
          for (const criteria of queries) {
            const rows = yield* store.matching(type, [...extra, ...criteria])
            for (const row of rows) {
              if (within(row.lastUpdated, ask._since, ask._till)) {
                found.add(row.id)
              }
            }
          }
        }
        const parts = chunked([...found].sort(), ask.chunk)
        const cut = parts.length === 0 ? [[] as ReadonlyArray<string>] : parts
        cut.forEach((ids, seq) =>
          cuts.push(
            JSON.stringify({
              type,
              ids,
              seq,
              container,
              format,
              ...(rules === undefined ? {} : { rules })
            })
          )
        )
      }
      return cuts
    })

  const gather = (
    type: string,
    ids: ReadonlyArray<string>,
    rules: Sealed | undefined
  ) =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const items: Array<Item> = []
      for (const id of ids) {
        const found = yield* store.current(type, id)
        if (found === undefined || found.deleted) {
          const failure: Failure =
            found === undefined
              ? new NotFound({ type, id })
              : new Gone({ type, id })
          items.push({ type, id, line: undefined, reason: why(failure) })
          continue
        }
        const body =
          rules === undefined ? found.body : apply(rules, found.body)
        lines.push(JSON.stringify(body))
      }
      return { lines, items }
    })

  const run = (unit: Unit) =>
    Effect.gen(function* () {
      const cut = yield* decoded(CutDoc, "export unit", unit.payload)
      const path = fileOf(unit.jobId, cut)
      yield* depot.note({
        job: unit.jobId,
        kind: unit.kind,
        container: cut.container,
        location: cut.rules?.location,
        etag: cut.rules?.etag,
        detail: `${cut.format} export`
      })
      const held = yield* gather(cut.type, cut.ids, cut.rules)
      yield* depot.fault(unit.jobId, unit.unitId, held.items)
      if (held.lines.length > 0) yield* depot.put(path, held.lines)
      yield* depot.mark({
        job: unit.jobId,
        unit: unit.unitId,
        type: cut.type,
        path: held.lines.length > 0 ? path : undefined,
        written: held.lines.length,
        skipped: 0,
        failed: held.items.length,
        scanned: cut.ids.length
      })
    })

  return { split, run }
}
