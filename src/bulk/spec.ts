import { Effect, ParseResult, Schema } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { types } from "../store/definitions.js"
import { SealedDoc, SetDoc } from "./rules.js"

export const NDJSON = "application/fhir+ndjson"

export const FORMATS: ReadonlyArray<string> = [
  NDJSON,
  "application/ndjson",
  "ndjson"
]

export const CHUNK = 100

export const CONTAINER = "export"

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/

const Ids = Schema.Array(Schema.String)

const Terms = Schema.Array(Schema.Tuple(Schema.String, Schema.String))

const ScopeDoc = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("system") }),
  Schema.Struct({ kind: Schema.Literal("patient"), ids: Ids }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    group: Schema.String,
    ids: Ids
  })
)

export const ExportDoc = Schema.Struct({
  scope: ScopeDoc,
  _type: Schema.optional(Ids),
  _typeFilter: Schema.optional(Ids),
  _since: Schema.optional(Schema.String),
  _till: Schema.optional(Schema.String),
  _outputFormat: Schema.optional(Schema.String),
  _container: Schema.optional(Schema.String),
  rules: Schema.optional(SetDoc),
  chunk: Schema.optional(Schema.Number)
})

export const CutDoc = Schema.Struct({
  type: Schema.String,
  ids: Ids,
  seq: Schema.Number,
  container: Schema.String,
  format: Schema.String,
  rules: Schema.optional(SealedDoc)
})

export const ImportDoc = Schema.Struct({
  input: Schema.Array(
    Schema.Struct({ type: Schema.String, path: Schema.String })
  ),
  chunk: Schema.optional(Schema.Number)
})

export const RowsDoc = Schema.Struct({
  type: Schema.String,
  path: Schema.String,
  from: Schema.Number,
  to: Schema.Number
})

export const PurgeDoc = Schema.Struct({
  type: Schema.String,
  criteria: Schema.optional(Terms),
  mode: Schema.optional(Schema.Literal("soft", "hard")),
  softDeleted: Schema.optional(Schema.Boolean),
  _maxCount: Schema.optional(Schema.Number),
  exclude: Schema.optional(Ids),
  chunk: Schema.optional(Schema.Number)
})

export const DropDoc = Schema.Struct({
  type: Schema.String,
  ids: Ids,
  mode: Schema.Literal("soft", "hard")
})

export const RewriteDoc = Schema.Struct({
  type: Schema.optional(Schema.String),
  criteria: Schema.optional(Terms),
  patch: Schema.Unknown,
  chunk: Schema.optional(Schema.Number)
})

export const MendDoc = Schema.Struct({
  type: Schema.String,
  ids: Ids,
  patch: Schema.Unknown
})

export const ReindexDoc = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  chunk: Schema.optional(Schema.Number)
})

export const ScanDoc = Schema.Struct({ type: Schema.String, ids: Ids })

export type Scope = typeof ScopeDoc.Type

export type Cut = typeof CutDoc.Type

export type Rows = typeof RowsDoc.Type

export type Drop = typeof DropDoc.Type

export type Mend = typeof MendDoc.Type

export type Scan = typeof ScanDoc.Type

export interface Filter {
  readonly type: string
  readonly criteria: ReadonlyArray<readonly [string, string]>
}

export const why = (failure: Failure): string =>
  toOutcome(failure).issue[0]?.diagnostics ?? "failed"

const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((problem) =>
      problem.path.length > 0
        ? `${problem.path.join(".")}: ${problem.message}`
        : problem.message
    )
    .join("; ")

export const decoded = <A, I>(
  schema: Schema.Schema<A, I>,
  what: string,
  doc: string
): Effect.Effect<A, Failure> =>
  Effect.try({
    try: () => JSON.parse(doc) as unknown,
    catch: () => new Rejected({ reason: `${what} is not json` })
  }).pipe(
    Effect.flatMap((held) =>
      Schema.decodeUnknown(schema)(held, { errors: "all" }).pipe(
        Effect.mapError(
          (error) =>
            new Rejected({ reason: `${what} not accepted: ${reasons(error)}` })
        )
      )
    )
  )

export const formatOf = (
  given: string | undefined
): Effect.Effect<string, Failure> => {
  const chosen = given ?? NDJSON
  return FORMATS.some((one) => one === chosen)
    ? Effect.succeed(chosen)
    : Effect.fail(
        new Rejected({ reason: `unsupported output format: ${chosen}` })
      )
}

export const containerOf = (
  given: string | undefined
): Effect.Effect<string, Failure> => {
  const chosen = given ?? CONTAINER
  return NAME.test(chosen)
    ? Effect.succeed(chosen)
    : Effect.fail(
        new Rejected({ reason: `container is not a name: ${chosen}` })
      )
}

export const typesOf = (
  given: ReadonlyArray<string> | undefined
): Effect.Effect<ReadonlyArray<string>, Failure> => {
  const all = types()
  if (given === undefined || given.length === 0) return Effect.succeed(all)
  const absent = given.filter((one) => !all.some((known) => known === one))
  return absent.length > 0
    ? Effect.fail(
        new Rejected({
          reason: `unsupported resource type: ${absent.join(", ")}`
        })
      )
    : Effect.succeed(given)
}

const termsOf = (
  type: string,
  query: string
): Effect.Effect<Filter, Failure> => {
  const terms: Array<readonly [string, string]> = []
  for (const term of query.split("&")) {
    const at = term.indexOf("=")
    if (at < 1) {
      return Effect.fail(
        new Rejected({ reason: `type filter term is not a pair: ${term}` })
      )
    }
    terms.push([
      decodeURIComponent(term.slice(0, at)),
      decodeURIComponent(term.slice(at + 1))
    ])
  }
  return Effect.map(typesOf([type]), () => ({ type, criteria: terms }))
}

export const filtersOf = (
  given: ReadonlyArray<string> | undefined
): Effect.Effect<ReadonlyArray<Filter>, Failure> =>
  Effect.forEach(given ?? [], (one) => {
    const at = one.indexOf("?")
    return at < 1
      ? Effect.fail(
          new Rejected({ reason: `type filter names no query: ${one}` })
        )
      : termsOf(one.slice(0, at), one.slice(at + 1))
  })

export const within = (
  stamp: string,
  since: string | undefined,
  till: string | undefined
): boolean =>
  (since === undefined || stamp >= since) &&
  (till === undefined || stamp < till)

export const chunked = <A>(
  items: ReadonlyArray<A>,
  size: number | undefined
): ReadonlyArray<ReadonlyArray<A>> => {
  const step = size !== undefined && size > 0 ? size : CHUNK
  const out: Array<ReadonlyArray<A>> = []
  for (let at = 0; at < items.length; at += step) {
    out.push(items.slice(at, at + step))
  }
  return out
}
