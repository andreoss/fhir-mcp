import { Effect, Schema } from "effect"
import { join } from "node:path"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { exists, readText, writeText } from "../tools/io.js"
import type { Verdict } from "./checks.js"

export interface Conformance {
  readonly revision: string
  readonly fhirVersion: string
  readonly software: { readonly name: string; readonly version: string }
  readonly checks: ReadonlyArray<Verdict>
  readonly unmet: ReadonlyArray<string>
}

const Shape = Schema.Struct({
  revision: Schema.String,
  fhirVersion: Schema.String,
  software: Schema.Struct({ name: Schema.String, version: Schema.String }),
  checks: Schema.Array(Schema.Struct({ id: Schema.String, met: Schema.Boolean })),
  unmet: Schema.Array(Schema.String)
})

export const pathOf = (dir: string, fhirVersion: string): string =>
  join(dir, `conformance-${fhirVersion}.json`)

const byId = <A extends { readonly id: string }>(
  rows: ReadonlyArray<A>
): ReadonlyArray<A> => [...rows].sort((a, b) => a.id.localeCompare(b.id))

const ordered = (found: Conformance): Conformance => ({
  ...found,
  checks: byId(found.checks),
  unmet: [...found.unmet].sort((a, b) => a.localeCompare(b))
})

export const load = (path: string): Effect.Effect<Conformance | undefined, Failure> =>
  Effect.gen(function* () {
    if (!(yield* exists(path))) return undefined
    const text = yield* readText(path)
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new Rejected({ reason: `${path} is not a conformance record` })
    })
    return yield* Schema.decodeUnknown(Shape)(raw).pipe(
      Effect.mapError(
        () => new Rejected({ reason: `${path} is not a conformance record` })
      )
    )
  })

export const save = (path: string, found: Conformance): Effect.Effect<void, Failure> =>
  writeText(path, `${JSON.stringify(ordered(found), undefined, 2)}\n`)

export const regressions = (
  before: Conformance | undefined,
  after: Conformance
): ReadonlyArray<string> => {
  if (before === undefined) return []
  const now = new Map(after.checks.map((one) => [one.id, one.met]))
  const lost = before.checks
    .filter((one) => one.met && now.get(one.id) !== true)
    .map((one) => one.id)
  const dropped = after.unmet.filter((id) => !before.unmet.includes(id))
  return [...new Set([...lost, ...dropped])].sort((a, b) => a.localeCompare(b))
}
