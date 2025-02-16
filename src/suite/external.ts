import { Effect, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { readText } from "../tools/io.js"
import type { Verdict } from "./checks.js"

export interface Expectation {
  readonly id: string
  readonly note: string
}

export interface Suite {
  readonly suite: string
  readonly version: string
  readonly expect: ReadonlyArray<Expectation>
}

const Shape = Schema.Struct({
  suite: Schema.String,
  version: Schema.String,
  expect: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      note: Schema.optionalWith(Schema.String, { default: () => "" })
    })
  )
})

const SHIPPED = fileURLToPath(new URL("expect/baseline.json", import.meta.url))

export const defaultSuite = (
  env: Record<string, string | undefined> = process.env
): string => env["FHIR_SUITE_EXPECTATIONS"] ?? SHIPPED

export const loadSuite = (path: string): Effect.Effect<Suite, Failure> =>
  Effect.gen(function* () {
    const text = yield* readText(path)
    const refused = () => new Rejected({ reason: `${path} is not an expectation list` })
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: refused
    })
    return yield* Schema.decodeUnknown(Shape)(raw).pipe(Effect.mapError(refused))
  })

export const unmet = (
  suite: Suite,
  verdicts: ReadonlyArray<Verdict>
): ReadonlyArray<string> => {
  const met = new Set(verdicts.filter((one) => one.met).map((one) => one.id))
  return suite.expect
    .filter((one) => !met.has(one.id))
    .map((one) => one.id)
    .sort((a, b) => a.localeCompare(b))
}
