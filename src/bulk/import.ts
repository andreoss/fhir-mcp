import { Effect, Either } from "effect"
import type { FhirResource } from "../core/engine.js"
import { Rules, Versions, defaults, update } from "../core/interactions.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Handler, Unit } from "../jobs/types.js"
import { check, render } from "../model/validate.js"
import type { Versioned } from "../store/versioned.js"
import type { Depot, Item } from "./depot.js"
import { CHUNK, ImportDoc, RowsDoc, decoded, typesOf, why } from "./spec.js"

interface Kept {
  readonly written: number
  readonly skipped: number
  readonly items: ReadonlyArray<Item>
}

const idOf = (body: FhirResource): string | undefined => {
  const held = body.id
  return typeof held === "string" && held.length > 0 ? held : undefined
}

export const importer = (store: Versioned, depot: Depot): Handler => {
  const split = (request: string) =>
    Effect.gen(function* () {
      const ask = yield* decoded(ImportDoc, "import", request)
      if (ask.input.length === 0) {
        return yield* Effect.fail(
          new Rejected({ reason: "import names no input" })
        )
      }
      const step = ask.chunk !== undefined && ask.chunk > 0 ? ask.chunk : CHUNK
      const cuts: Array<string> = []
      for (const one of ask.input) {
        yield* typesOf([one.type])
        const lines = yield* depot.get(one.path)
        for (let at = 0; at < Math.max(lines.length, 1); at += step) {
          cuts.push(
            JSON.stringify({
              type: one.type,
              path: one.path,
              from: at + 1,
              to: Math.min(at + step, lines.length) + 1
            })
          )
        }
      }
      return cuts
    })

  const take = (type: string, line: number, text: string) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.either(
        Effect.try({
          try: () => JSON.parse(text) as FhirResource,
          catch: (): Failure => new Rejected({ reason: "row is not json" })
        })
      )
      if (Either.isLeft(parsed)) {
        return { type, id: undefined, line, reason: "row is not json" }
      }
      const problems = check(type, parsed.right)
      if (problems.length > 0) {
        return {
          type,
          id: idOf(parsed.right),
          line,
          reason: problems.map(render).join("; ")
        }
      }
      const id = idOf(parsed.right)
      if (id === undefined) {
        return { type, id: undefined, line, reason: "row carries no id" }
      }
      const written = yield* Effect.either(
        update(type, id, parsed.right).pipe(
          Effect.provideService(Versions, store),
          Effect.provideService(Rules, defaults)
        )
      )
      return Either.isLeft(written)
        ? { type, id, line, reason: why(written.left) }
        : written.right.changed
    })

  const load = (
    type: string,
    from: number,
    lines: ReadonlyArray<string>
  ): Effect.Effect<Kept, Failure> =>
    Effect.gen(function* () {
      const items: Array<Item> = []
      let written = 0
      let skipped = 0
      for (const [at, text] of lines.entries()) {
        if (text.trim().length === 0) continue
        const held = yield* take(type, from + at, text)
        if (typeof held !== "boolean") items.push(held)
        else if (held) written = written + 1
        else skipped = skipped + 1
      }
      return { written, skipped, items }
    })

  const run = (unit: Unit) =>
    Effect.gen(function* () {
      const cut = yield* decoded(RowsDoc, "import unit", unit.payload)
      yield* depot.note({
        job: unit.jobId,
        kind: unit.kind,
        container: cut.path,
        location: undefined,
        etag: undefined,
        detail: "ndjson import"
      })
      const lines = yield* depot.get(cut.path)
      const held = yield* load(
        cut.type,
        cut.from,
        lines.slice(cut.from - 1, cut.to - 1)
      )
      yield* depot.fault(unit.jobId, unit.unitId, held.items)
      yield* depot.mark({
        job: unit.jobId,
        unit: unit.unitId,
        type: cut.type,
        path: cut.path,
        written: held.written,
        skipped: held.skipped,
        failed: held.items.length,
        scanned: lines.length
      })
    })

  return { split, run }
}
