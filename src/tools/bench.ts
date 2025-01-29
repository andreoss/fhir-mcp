import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import type { Failure } from "../core/outcome.js"
import { versionedOn } from "../store/versioned.js"
import { ArgsError, Count, Ratio, Whole, oneOf, parse } from "./args.js"
import { connect } from "./db.js"
import { readText, writeText } from "./io.js"
import { emit, storePath } from "./result.js"
import type { Outcome } from "./result.js"

export type Shape = "patient" | "observation" | "mixed"

export type Generated = FhirResource & { readonly id: string }

export interface Latency {
  readonly p50: number
  readonly p90: number
  readonly p99: number
  readonly max: number
}

export interface Summary {
  readonly label: string
  readonly shape: Shape
  readonly size: number
  readonly operations: number
  readonly errors: number
  readonly elapsedMs: number
  readonly throughput: number
  readonly latencyMs: Latency
}

export interface Measured {
  readonly label: string
  readonly shape: Shape
  readonly size: number
  readonly samples: ReadonlyArray<number>
  readonly errors: number
  readonly elapsedMs: number
}

export interface Workload {
  readonly label: string
  readonly shape: Shape
  readonly size: number
  readonly seed: number
}

export interface Delta {
  readonly metric: string
  readonly before: number
  readonly after: number
  readonly ratio: number
  readonly regressed: boolean
}

export interface Comparison {
  readonly action: "compare"
  readonly before: string
  readonly after: string
  readonly tolerance: number
  readonly rows: ReadonlyArray<Delta>
  readonly regressed: ReadonlyArray<string>
}

const FAMILY = ["Simpson", "Flanders", "Bouvier", "Wiggum", "Lovejoy", "Szyslak"]
const GIVEN = ["Homer", "Marge", "Ned", "Clancy", "Timothy", "Moe"]
const GENDER = ["male", "female", "other", "unknown"]
const CODE = ["8867-4", "8480-6", "9279-1", "2708-6"]
const STATUS = ["final", "amended", "preliminary"]

const stream = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(list: ReadonlyArray<A>, random: () => number): A =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))] as A

const patientAt = (at: number, random: () => number): Generated => ({
  resourceType: "Patient",
  id: `p-${at}`,
  name: [{ family: pick(FAMILY, random), given: [pick(GIVEN, random)] }],
  gender: pick(GENDER, random),
  birthDate: `${1940 + Math.floor(random() * 60)}-03-14`
})

const observationAt = (at: number, random: () => number): Generated => ({
  resourceType: "Observation",
  id: `o-${at}`,
  status: pick(STATUS, random),
  code: { coding: [{ code: pick(CODE, random) }] },
  subject: { reference: `Patient/p-${Math.floor(random() * 1000)}` }
})

export const generate = (
  shape: Shape,
  size: number,
  seed: number
): ReadonlyArray<Generated> => {
  const random = stream(seed)
  const made: Array<Generated> = []
  for (let at = 0; at < size; at += 1) {
    const patient = shape === "patient" || (shape === "mixed" && at % 2 === 0)
    made.push(patient ? patientAt(at, random) : observationAt(at, random))
  }
  return made
}

const round = (value: number): number => Math.round(value * 1000) / 1000

const rank = (sorted: ReadonlyArray<number>, quantile: number): number => {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))
  return round(sorted[at] as number)
}

export const summarize = (measured: Measured): Summary => {
  const sorted = [...measured.samples].sort((a, b) => a - b)
  const seconds = Math.max(measured.elapsedMs, 0.001) / 1000
  return {
    label: measured.label,
    shape: measured.shape,
    size: measured.size,
    operations: sorted.length,
    errors: measured.errors,
    elapsedMs: round(measured.elapsedMs),
    throughput: sorted.length === 0 ? 0 : round(sorted.length / seconds),
    latencyMs: {
      p50: rank(sorted, 0.5),
      p90: rank(sorted, 0.9),
      p99: rank(sorted, 0.99),
      max: rank(sorted, 1)
    }
  }
}

export const measure = (
  connection: DuckDBConnection,
  workload: Workload
): Effect.Effect<Summary, Failure> =>
  Effect.gen(function* () {
    const store = yield* versionedOn(connection)
    const resources = generate(workload.shape, workload.size, workload.seed)
    const samples: Array<number> = []
    let errors = 0
    const timed = <A>(work: Effect.Effect<A, Failure>) =>
      Effect.gen(function* () {
        const at = performance.now()
        const result = yield* Effect.either(work)
        samples.push(performance.now() - at)
        if (result._tag === "Left") errors += 1
      })
    const begun = performance.now()
    for (const body of resources) {
      const lastUpdated = yield* store.stamp()
      const existing = yield* store.current(body.resourceType, body.id)
      yield* timed(
        store.insertVersion({
          type: body.resourceType,
          id: body.id,
          versionId: (existing?.versionId ?? 0) + 1,
          lastUpdated,
          deleted: false,
          body
        })
      )
    }
    for (const body of resources) {
      yield* timed(store.current(body.resourceType, body.id))
    }
    return summarize({
      label: workload.label,
      shape: workload.shape,
      size: workload.size,
      samples,
      errors,
      elapsedMs: performance.now() - begun
    })
  })

const METRICS: ReadonlyArray<keyof Latency | "throughput"> = [
  "throughput",
  "p50",
  "p90",
  "p99",
  "max"
]

const valueOf = (summary: Summary, metric: keyof Latency | "throughput"): number =>
  metric === "throughput" ? summary.throughput : summary.latencyMs[metric]

export const compare = (
  before: Summary,
  after: Summary,
  tolerance: number
): Comparison => {
  const rows = METRICS.map((metric) => {
    const was = valueOf(before, metric)
    const is = valueOf(after, metric)
    const regressed =
      metric === "throughput" ? is < was * (1 - tolerance) : is > was * (1 + tolerance)
    return { metric, before: was, after: is, ratio: was === 0 ? 0 : round(is / was), regressed }
  })
  return {
    action: "compare",
    before: before.label,
    after: after.label,
    tolerance,
    rows,
    regressed: rows.filter((row) => row.regressed).map((row) => row.metric)
  }
}

const Recorded = Schema.Struct({
  label: Schema.String,
  shape: oneOf("patient", "observation", "mixed"),
  size: Schema.Number,
  operations: Schema.Number,
  errors: Schema.Number,
  elapsedMs: Schema.Number,
  throughput: Schema.Number,
  latencyMs: Schema.Struct({
    p50: Schema.Number,
    p90: Schema.Number,
    p99: Schema.Number,
    max: Schema.Number
  })
})

const unreadable = (option: string, path: string) =>
  new ArgsError({ problems: [`--${option}: ${path} is not a run report`] })

const readSummary = (option: string, path: string): Effect.Effect<Summary, ArgsError> =>
  readText(path).pipe(
    Effect.mapError(() => unreadable(option, path)),
    Effect.flatMap((text) => {
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return Effect.fail(unreadable(option, path))
      }
      return Schema.decodeUnknown(Recorded)(raw).pipe(
        Effect.mapError(() => unreadable(option, path))
      )
    })
  )

const spec = {
  verbs: ["generate", "run", "compare"] as ReadonlyArray<string>,
  flags: [] as ReadonlyArray<string>,
  fields: {
    store: Schema.optional(Schema.String),
    shape: Schema.optionalWith(oneOf("patient", "observation", "mixed"), {
      default: () => "patient" as const
    }),
    size: Schema.optionalWith(Count, { default: () => 100 }),
    seed: Schema.optionalWith(Whole, { default: () => 1 }),
    label: Schema.optionalWith(Schema.String, { default: () => "run" }),
    out: Schema.optional(Schema.String),
    before: Schema.optional(Schema.String),
    after: Schema.optional(Schema.String),
    tolerance: Schema.optionalWith(Ratio, { default: () => 0.1 })
  }
}

export const run = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>
): Effect.Effect<Outcome, ArgsError | Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const parsed = yield* parse(spec, argv)
    const options = parsed.options
    if (parsed.verb === "generate") {
      const out = options.out
      if (out === undefined) {
        return yield* Effect.fail(
          new ArgsError({ problems: ["--out: naming the file to write is required"] })
        )
      }
      const made = generate(options.shape, options.size, options.seed)
      yield* writeText(out, `${made.map((body) => JSON.stringify(body)).join("\n")}\n`)
      return emit({
        action: "generate",
        shape: options.shape,
        size: options.size,
        seed: options.seed,
        out
      })
    }
    if (parsed.verb === "compare") {
      const before = options.before
      const after = options.after
      const missing = [
        ...(before === undefined ? ["--before: naming a run report is required"] : []),
        ...(after === undefined ? ["--after: naming a run report is required"] : [])
      ]
      if (missing.length > 0) return yield* Effect.fail(new ArgsError({ problems: missing }))
      const first = yield* readSummary("before", before as string)
      const second = yield* readSummary("after", after as string)
      const found = compare(first, second, options.tolerance)
      return emit(found, found.regressed.length > 0 ? 1 : 0)
    }
    const connection = yield* connect(storePath(options.store, env))
    return emit(
      yield* measure(connection, {
        label: options.label,
        shape: options.shape,
        size: options.size,
        seed: options.seed
      })
    )
  })
