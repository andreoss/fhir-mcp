import { Clock, Context, Effect, Layer, Ref } from "effect"
import { known } from "./correlation.js"
import { TelemetrySink } from "./sink.js"
import type { Level } from "./sink.js"

export const OPS = ["bundle", "export", "import", "reindex", "search"] as const
export type Op = (typeof OPS)[number]

export const JOBS = ["bulk-delete", "bulk-update", "export", "import", "reindex"] as const

export const OUTCOMES = ["success", "failure"] as const
export type Outcome = (typeof OUTCOMES)[number]

export const TYPES = [
  "AllergyIntolerance",
  "Bundle",
  "CapabilityStatement",
  "CodeSystem",
  "Condition",
  "DiagnosticReport",
  "DocumentReference",
  "Encounter",
  "Immunization",
  "Location",
  "MedicationRequest",
  "Observation",
  "OperationOutcome",
  "Organization",
  "Patient",
  "Practitioner",
  "Procedure",
  "SearchParameter",
  "StructureDefinition",
  "ValueSet"
] as const

export const OTHER = "other"
export const UNSET = "unset"

export const KINDS = {
  op: { op: OPS, type: TYPES, outcome: OUTCOMES },
  job: { job: JOBS, outcome: OUTCOMES }
} as const

export type Kind = keyof typeof KINDS

export type Dims = Readonly<Record<string, string>>

const allowed = (values: ReadonlyArray<string>, given: string | undefined): string =>
  given === undefined ? UNSET : values.includes(given) ? given : OTHER

export const normalize = (kind: Kind, given: Dims): Dims => {
  const fixed: Record<string, string> = {}
  for (const [name, values] of Object.entries(KINDS[kind])) {
    fixed[name] = allowed(values, given[name])
  }
  return fixed
}

const series = (kind: Kind, dims: Dims): string =>
  `${kind}|${Object.values(dims).join("|")}`

export interface Limit {
  readonly burst: number
  readonly perSecond: number
}

export const DEFAULT_LIMIT: Limit = { burst: 20, perSecond: 20 }

interface Bucket {
  readonly tokens: number
  readonly at: number
}

export interface Emitter {
  readonly emit: (kind: Kind, dims: Dims, level?: Level) => Effect.Effect<void>
  readonly dropped: Effect.Effect<number>
}

export class Telemetry extends Context.Tag("Telemetry")<Telemetry, Emitter>() {}

const make = (limit: Limit) =>
  Effect.gen(function* () {
    const sink = yield* TelemetrySink
    const buckets = yield* Ref.make(new Map<string, Bucket>())
    const drops = yield* Ref.make(0)

    const permit = (key: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.modify(buckets, (held) => {
            const bucket = held.get(key)
            const tokens =
              bucket === undefined
                ? limit.burst
                : Math.min(
                    limit.burst,
                    bucket.tokens + ((now - bucket.at) * limit.perSecond) / 1000
                  )
            const ok = tokens >= 1
            held.set(key, { tokens: ok ? tokens - 1 : tokens, at: now })
            return [ok, held]
          })
        )
      )

    const emit = (kind: Kind, dims: Dims, level: Level = "info") =>
      Effect.gen(function* () {
        const fixed = normalize(kind, dims)
        if (!(yield* permit(series(kind, fixed)))) {
          return yield* Ref.update(drops, (count) => count + 1)
        }
        const correlation = yield* known
        const at = new Date(yield* Clock.currentTimeMillis).toISOString()
        yield* sink.emit({ at, level, kind, correlation, dims: fixed })
      })

    return Telemetry.of({ emit, dropped: Ref.get(drops) })
  })

export const layer = (
  limit: Limit = DEFAULT_LIMIT
): Layer.Layer<Telemetry, never, TelemetrySink> => Layer.effect(Telemetry, make(limit))

export interface OpDims extends Dims {
  readonly op: string
  readonly type: string
  readonly outcome: string
}

export const opDims = (op: string, type: string, outcome: string): OpDims => ({
  op: allowed(OPS, op),
  type: allowed(TYPES, type),
  outcome: allowed(OUTCOMES, outcome)
})
