import { Context, Effect, Layer, ParseResult, Schema } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { CodeSystem, Concept, Designation } from "./system.js"

export interface Files {
  readonly list: (dir: string) => Effect.Effect<ReadonlyArray<string>, Failure>
  readonly read: (path: string) => Effect.Effect<string, Failure>
}

export class TerminologyFiles extends Context.Tag("TerminologyFiles")<
  TerminologyFiles,
  Files
>() {}

const RawDesignation = Schema.Struct({
  language: Schema.optional(Schema.String),
  use: Schema.optional(Schema.String),
  value: Schema.String
})

const RawProperty = Schema.Struct({
  code: Schema.String,
  valueBoolean: Schema.optional(Schema.Boolean),
  valueCode: Schema.optional(Schema.String)
})

interface RawConcept {
  readonly code: string
  readonly display?: string | undefined
  readonly designation?: ReadonlyArray<Schema.Schema.Type<typeof RawDesignation>> | undefined
  readonly property?: ReadonlyArray<Schema.Schema.Type<typeof RawProperty>> | undefined
  readonly concept?: ReadonlyArray<RawConcept> | undefined
}

const RawConcept: Schema.Schema<RawConcept> = Schema.Struct({
  code: Schema.String,
  display: Schema.optional(Schema.String),
  designation: Schema.optional(Schema.Array(RawDesignation)),
  property: Schema.optional(Schema.Array(RawProperty)),
  concept: Schema.optional(Schema.Array(Schema.suspend(() => RawConcept)))
})

const RawSystem = Schema.Struct({
  resourceType: Schema.Literal("CodeSystem"),
  url: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
  caseSensitive: Schema.optional(Schema.Boolean),
  content: Schema.Literal("complete", "fragment", "example", "supplement", "not-present"),
  concept: Schema.optional(Schema.Array(RawConcept))
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const designationsOf = (raw: RawConcept): ReadonlyArray<Designation> | undefined => {
  const list = raw.designation
  if (list === undefined || list.length === 0) return undefined
  return list.map((item) => ({
    value: item.value,
    ...(item.language === undefined ? {} : { language: item.language }),
    ...(item.use === undefined ? {} : { use: item.use })
  }))
}

const inactiveOf = (raw: RawConcept): boolean =>
  (raw.property ?? []).some(
    (property) =>
      (property.code === "inactive" && property.valueBoolean === true) ||
      (property.code === "status" &&
        (property.valueCode === "retired" || property.valueCode === "inactive"))
  )

const flatten = (
  raws: ReadonlyArray<RawConcept>,
  parent: string | undefined
): ReadonlyArray<Concept> =>
  raws.flatMap((raw) => {
    const designation = designationsOf(raw)
    const concept: Concept = {
      code: raw.code,
      ...(raw.display === undefined ? {} : { display: raw.display }),
      ...(parent === undefined ? {} : { parent }),
      ...(inactiveOf(raw) ? { inactive: true } : {}),
      ...(designation === undefined ? {} : { designation })
    }
    return [concept, ...flatten(raw.concept ?? [], raw.code)]
  })

const problem = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) => `${issue.path.join(".") || "resource"} ${issue.message}`)
    .join("; ")

const one = (name: string, value: unknown): Effect.Effect<CodeSystem, Failure> => {
  if (!isRecord(value) || value["resourceType"] !== "CodeSystem") {
    return Effect.fail(new Rejected({ reason: `${name}: not a code system` }))
  }
  return Schema.decodeUnknown(RawSystem)(value, { errors: "all" }).pipe(
    Effect.mapError((error) => new Rejected({ reason: `${name}: ${problem(error)}` })),
    Effect.flatMap((raw) => {
      const concept = flatten(raw.concept ?? [], undefined)
      if (concept.length === 0) {
        return Effect.fail(new Rejected({ reason: `${name}: ${raw.url} carries no concept` }))
      }
      const system: CodeSystem = {
        url: raw.url,
        content: raw.content,
        concept,
        ...(raw.version === undefined ? {} : { version: raw.version }),
        ...(raw.date === undefined ? {} : { date: raw.date }),
        ...(raw.caseSensitive === undefined ? {} : { caseSensitive: raw.caseSensitive })
      }
      return Effect.succeed(system)
    })
  )
}

const bundle = (name: string, value: Record<string, unknown>) => {
  const entries = value["entry"]
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) {
    return Effect.fail(new Rejected({ reason: `${name}: carries no code system` }))
  }
  return Effect.forEach(list, (entry: unknown, index) =>
    one(`${name}[${index}]`, isRecord(entry) ? entry["resource"] : entry)
  )
}

export const parse = (
  name: string,
  text: string
): Effect.Effect<ReadonlyArray<CodeSystem>, Failure> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new Rejected({ reason: `${name}: not json` })
  }).pipe(
    Effect.flatMap((value) =>
      isRecord(value) && value["resourceType"] === "Bundle"
        ? bundle(name, value)
        : Effect.map(one(name, value), (system) => [system])
    )
  )

export const load = (
  dir: string
): Effect.Effect<ReadonlyArray<CodeSystem>, Failure, TerminologyFiles> =>
  Effect.gen(function* () {
    const files = yield* TerminologyFiles
    const names = yield* files.list(dir)
    const read = yield* Effect.forEach(names, (name) =>
      Effect.flatMap(files.read(name), (text) => parse(name, text))
    )
    return read.flat()
  })

const unreadable = () => new Unavailable({ dependency: "terminology directory" })

export const nodeFiles: Files = {
  list: (dir) =>
    Effect.tryPromise({
      try: async () => {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => join(dir, entry.name))
          .sort()
      },
      catch: unreadable
    }),
  read: (path) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: unreadable })
}

export const filesLayer: Layer.Layer<TerminologyFiles> = Layer.succeed(
  TerminologyFiles,
  nodeFiles
)
