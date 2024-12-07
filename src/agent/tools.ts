import { Effect, ParseResult, Schema } from "effect"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, FhirResource } from "../core/engine.js"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface ToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly type: "object"; readonly properties: Record<string, unknown>; readonly required: ReadonlyArray<string> }
  readonly annotations: ToolAnnotations
}

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly isError: boolean
  readonly elided?: { readonly returned: number; readonly of: number }
}

export const DEFAULT_MAX_ENTRIES = 25

const ResourceType = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Za-z]{1,63}$/)
).annotations({ message: () => "type: expected a resource type name" })

const Id = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/)
).annotations({ message: () => "id: expected a resource id" })

const Max = Schema.Number.pipe(Schema.int(), Schema.between(1, 1000))

const ReadArgs = Schema.Struct({ type: ResourceType, id: Id })

const SearchArgs = Schema.Struct({
  type: ResourceType,
  parameters: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    default: () => ({})
  }),
  max: Schema.optionalWith(Max, { default: () => DEFAULT_MAX_ENTRIES })
})

const CapabilitiesArgs = Schema.Struct({
  type: Schema.optional(ResourceType)
})

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

export const tools: ReadonlyArray<ToolSpec> = [
  {
    name: "read",
    description: "Retrieve one resource by type and id.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Resource type name." },
        id: { type: "string", description: "Logical id of the resource." }
      },
      required: ["type", "id"]
    },
    annotations: readOnly
  },
  {
    name: "search",
    description: "Search one resource type and return a bundle of matches.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Resource type name." },
        parameters: { type: "object", description: "Search parameter names and values." },
        max: { type: "integer", description: "Largest number of entries to return." }
      },
      required: ["type"]
    },
    annotations: readOnly
  },
  {
    name: "capabilities",
    description: "Report the resource types served and the parameters a type accepts.",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", description: "Resource type name." } },
      required: []
    },
    annotations: readOnly
  }
]

const names = new Set(tools.map((tool) => tool.name))

const text = (value: unknown): ReadonlyArray<{ readonly type: "text"; readonly text: string }> => [
  { type: "text", text: JSON.stringify(value) }
]

const failed = (failure: Failure): ToolResult => ({
  content: text(toOutcome(failure)),
  isError: true
})

const succeeded = (value: unknown, elided?: { readonly returned: number; readonly of: number }): ToolResult =>
  elided === undefined
    ? { content: text(value), isError: false }
    : { content: text(value), isError: false, elided }

const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ")

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error) => new Rejected({ reason: reasons(error) }))
  )

const budget = (bundle: Bundle, max: number): { readonly bundle: Bundle; readonly elided?: { readonly returned: number; readonly of: number } } => {
  const entries = bundle.entry ?? []
  if (entries.length <= max) return { bundle }
  const total = bundle.total ?? entries.length
  return {
    bundle: { ...bundle, entry: entries.slice(0, max) },
    elided: { returned: max, of: total }
  }
}

const readTool = (args: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decode(ReadArgs, args)
    const engine = yield* FhirEngine
    const resource: FhirResource = yield* engine.read(decoded.type, decoded.id)
    return succeeded(resource)
  })

const searchTool = (args: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decode(SearchArgs, args)
    const engine = yield* FhirEngine
    const found = yield* engine.search({
      type: decoded.type,
      parameters: Object.entries(decoded.parameters)
    })
    const reduced = budget(found, decoded.max)
    return succeeded(reduced.bundle, reduced.elided)
  })

const capabilitiesTool = (args: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decode(CapabilitiesArgs, args)
    const engine = yield* FhirEngine
    const resourceTypes = yield* engine.resourceTypes()
    if (decoded.type === undefined) return succeeded({ resourceTypes })
    const parameters = yield* engine.searchParameters(decoded.type)
    return succeeded({ resourceTypes, type: decoded.type, parameters })
  })

export const call = (name: string, args: unknown): Effect.Effect<ToolResult, never, FhirEngine> => {
  if (!names.has(name)) {
    return Effect.succeed(failed(new Rejected({ reason: `unknown tool: ${name}` })))
  }
  const chosen =
    name === "read" ? readTool(args) : name === "search" ? searchTool(args) : capabilitiesTool(args)
  return chosen.pipe(Effect.catchAll((failure) => Effect.succeed(failed(failure))))
}
