import { Effect, ParseResult, Schema } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"
import { Forbidden, Rejected } from "../core/outcome.js"
import { BUCKETS, Metrics } from "./metrics.js"
import type { Series } from "./metrics.js"

export interface Access {
  readonly exposed: boolean
  readonly digest: string | undefined
}

export const RESTRICTED: Access = { exposed: false, digest: undefined }

export const ACTION = "metrics-scrape"

const Fields = Schema.Struct({
  FHIR_METRICS_EXPOSE: Schema.optionalWith(
    Schema.Literal("off", "on").annotations({
      message: (issue) => `expected "off" or "on", got ${JSON.stringify(issue.actual)}`
    }),
    { default: () => "off" as const }
  ),
  FHIR_METRICS_TOKEN: Schema.optional(Schema.String)
})

export const digest = (token: string): string =>
  createHash("sha256").update(token).digest("hex")

const owned = (env: Record<string, string | undefined>): Record<string, string> => {
  const held: Record<string, string> = {}
  for (const key of Object.keys(Fields.fields)) {
    const raw = env[key]
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    held[key] = trimmed
  }
  return held
}

const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((problem) =>
      problem.path.length > 0
        ? `${problem.path.join(".")}: ${problem.message}`
        : problem.message
    )
    .join("; ")

export const load = (
  env: Record<string, string | undefined>
): Effect.Effect<Access, Rejected> =>
  Schema.decodeUnknown(Fields)(owned(env), { errors: "all" }).pipe(
    Effect.mapError((error) => new Rejected({ reason: reasons(error) })),
    Effect.flatMap((decoded) => {
      if (decoded.FHIR_METRICS_EXPOSE === "off") return Effect.succeed(RESTRICTED)
      const token = decoded.FHIR_METRICS_TOKEN
      return token === undefined
        ? Effect.fail(
            new Rejected({ reason: "FHIR_METRICS_TOKEN: exposing metrics requires a token" })
          )
        : Effect.succeed({ exposed: true, digest: digest(token) })
    })
  )

const matches = (held: string | undefined, presented: string | undefined): boolean => {
  if (held === undefined || presented === undefined) return false
  const a = Buffer.from(held, "hex")
  const b = Buffer.from(digest(presented), "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

const labels = (series: Series, withOutcome: boolean): string => {
  const pairs = [
    `op="${series.op}"`,
    `type="${series.type}"`,
    ...(withOutcome ? [`outcome="${series.outcome}"`] : [])
  ]
  return `{${pairs.join(",")}}`
}

const failures = (
  series: ReadonlyArray<Series>
): ReadonlyArray<readonly [string, number]> => {
  const totals = new Map<string, number>()
  for (const entry of series) {
    const label = labels(entry, false)
    const failed = entry.outcome === "failure" ? entry.count : 0
    totals.set(label, (totals.get(label) ?? 0) + failed)
  }
  return [...totals]
}

export const exposition = (series: ReadonlyArray<Series>): string => {
  if (series.length === 0) return ""
  const lines: Array<string> = [
    "# HELP fhir_op_total Operations recorded by kind, resource type and outcome.",
    "# TYPE fhir_op_total counter"
  ]
  for (const entry of series) {
    lines.push(`fhir_op_total${labels(entry, true)} ${entry.count}`)
  }
  lines.push("# HELP fhir_op_failures_total Operations that failed.")
  lines.push("# TYPE fhir_op_failures_total counter")
  for (const [label, count] of failures(series)) {
    lines.push(`fhir_op_failures_total${label} ${count}`)
  }
  lines.push("# HELP fhir_op_latency_ms Operation latency in milliseconds.")
  lines.push("# TYPE fhir_op_latency_ms histogram")
  for (const entry of series) {
    const label = labels(entry, true).slice(0, -1)
    BUCKETS.forEach((edge, index) => {
      const held = entry.buckets[index] ?? 0
      lines.push(`fhir_op_latency_ms_bucket${label},le="${edge}"} ${held}`)
    })
    lines.push(`fhir_op_latency_ms_bucket${label},le="+Inf"} ${entry.count}`)
    lines.push(`fhir_op_latency_ms_sum${labels(entry, true)} ${entry.sum}`)
    lines.push(`fhir_op_latency_ms_count${labels(entry, true)} ${entry.count}`)
  }
  return `${lines.join("\n")}\n`
}

export const scrape = (
  access: Access,
  presented: string | undefined
): Effect.Effect<string, Forbidden, Metrics> =>
  access.exposed && matches(access.digest, presented)
    ? Metrics.pipe(Effect.flatMap((meter) => Effect.map(meter.snapshot, exposition)))
    : Effect.fail(new Forbidden({ action: ACTION }))
