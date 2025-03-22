import { Context, Duration, Effect, Option, ParseResult, Schema } from "effect"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, FhirResource } from "../core/engine.js"
import { Rejected, Unavailable, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { issue, redeem } from "./cursor.js"
import { keep, missing, missingIn } from "./elements.js"
import { CurrentSession, Limiter, limited } from "./limit.js"
import type { Admission } from "./limit.js"
import { OperationName, Parameters, flatten, named, refusal } from "./params.js"
import type { Pair, Scope } from "./params.js"

export interface ToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required: ReadonlyArray<string>
  }
  readonly annotations: ToolAnnotations
}

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly isError: boolean
  readonly elided?: { readonly returned: number; readonly of: number }
}

export interface OperationCall {
  readonly name: string
  readonly type: string
  readonly id?: string
  readonly parameters: ReadonlyArray<Pair>
}

export interface Operations {
  readonly invoke: (call: OperationCall) => Effect.Effect<Bundle, Failure>
}

export class FhirOperations extends Context.Tag("FhirOperations")<
  FhirOperations,
  Operations
>() {}

export interface Bound {
  readonly millis: number
}

export class Deadline extends Context.Tag("AgentDeadline")<Deadline, Bound>() {}

export const DEFAULT_MAX_ENTRIES = 25

export const DEFAULT_DEADLINE_MS = 30_000

const ResourceType = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Za-z]{1,63}$/)
).annotations({ message: () => "type: expected a resource type name" })

const Id = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/)
).annotations({ message: () => "id: expected a resource id" })

const ElementPath = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/)
).annotations({ message: () => "elements: expected an element path" })

const Max = Schema.Number.pipe(Schema.int(), Schema.between(1, 1000))

const Elements = Schema.optionalWith(Schema.Array(ElementPath), {
  default: () => [] as ReadonlyArray<string>
})

const ReadArgs = Schema.Struct({
  type: ResourceType,
  id: Id,
  elements: Elements,
  parameters: Parameters,
  operation: Schema.optional(OperationName),
  max: Schema.optional(Max)
})

const SearchArgs = Schema.Struct({
  type: ResourceType,
  parameters: Parameters,
  elements: Elements,
  max: Schema.optionalWith(Max, { default: () => DEFAULT_MAX_ENTRIES }),
  cursor: Schema.optional(Schema.String),
  operation: Schema.optional(OperationName)
})

const CapabilitiesArgs = Schema.Struct({ type: Schema.optional(ResourceType) })

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

const elementsProperty = {
  type: "array",
  items: { type: "string" },
  description: "Element paths to keep, such as name.family. Omit for the whole resource."
}

const parametersProperty = {
  type: "object",
  description:
    "Search parameter names and values. A value may be a list, which repeats " +
    "the parameter and narrows the answer, as in " +
    '{"date": ["ge2024-01-01", "le2024-12-31"]}.'
}

const operationProperty = {
  type: "string",
  enum: named(),
  description: "Named operation to invoke in place of the plain interaction."
}

const maxProperty = { type: "integer", description: "Largest number of entries to return." }

export const tools: ReadonlyArray<ToolSpec> = [
  {
    name: "read",
    description:
      "Retrieve one resource by type and id, or invoke an operation on it. " +
      "Call capabilities first to learn which resource types the server serves.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Resource type name." },
        id: { type: "string", description: "Logical id of the resource." },
        elements: elementsProperty,
        parameters: parametersProperty,
        operation: operationProperty,
        max: maxProperty
      },
      required: ["type", "id"]
    },
    annotations: readOnly
  },
  {
    name: "search",
    description:
      "Search one resource type, or invoke an operation on the type. " +
      "Call capabilities first to learn which resource types are served and " +
      "the search parameters each accepts.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Resource type name." },
        parameters: parametersProperty,
        elements: elementsProperty,
        max: maxProperty,
        cursor: { type: "string", description: "Continuation token from a previous answer." },
        operation: operationProperty
      },
      required: ["type"]
    },
    annotations: readOnly
  },
  {
    name: "capabilities",
    description: "Report the resource types served, their parameters and operations.",
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

const refused = (found: OperationOutcome): ToolResult => ({ content: text(found), isError: true })

const failed = (failure: Failure): ToolResult => refused(toOutcome(failure))

const expired = (millis: number): ToolResult =>
  refused({
    resourceType: "OperationOutcome",
    issue: [
      {
        severity: "error",
        code: "transient",
        diagnostics:
          `deadline of ${millis}ms expired; ` +
          `retry after ${Math.max(1, Math.ceil(millis / 1000))}s`
      }
    ]
  })

const succeeded = (
  value: unknown,
  elided?: { readonly returned: number; readonly of: number },
  gaps: ReadonlyArray<string> = []
): ToolResult => ({
  content: [...text(value), ...(gaps.length === 0
    ? []
    : [{ type: "text" as const, text: `elements matched nothing: ${gaps.join(", ")}` }])],
  isError: false,
  ...(elided === undefined ? {} : { elided })
})

const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((problem) =>
      problem.path.length > 0 ? `${problem.path.join(".")}: ${problem.message}` : problem.message
    )
    .join("; ")

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error) => new Rejected({ reason: reasons(error) }))
  )

const reject = (reason: string) => Effect.fail(new Rejected({ reason }))

const trimmed = (
  found: Bundle,
  elements: ReadonlyArray<string>,
  max: number
): ToolResult => {
  const all = found.entry ?? []
  const entry = all.slice(0, max).map((one) => ({
    ...one,
    resource: keep(one.resource as Record<string, unknown>, elements) as FhirResource
  }))
  const total = found.total ?? all.length
  const bundle = { ...found, total, entry }
  const gaps = missingIn(all.map((one) => one.resource as Record<string, unknown>), elements)
  return entry.length < total
    ? succeeded(bundle, { returned: entry.length, of: total }, gaps)
    : succeeded(bundle, undefined, gaps)
}

interface Asked {
  readonly name: string
  readonly scope: Scope
  readonly type: string
  readonly id?: string
  readonly parameters: ReadonlyArray<Pair>
  readonly elements: ReadonlyArray<string>
  readonly max: number
}

const operate = (asked: Asked): Effect.Effect<ToolResult, Failure> =>
  Effect.gen(function* () {
    const why = refusal(asked.name, asked.type, asked.scope)
    if (why !== undefined) return yield* reject(why)
    const port = yield* Effect.serviceOption(FhirOperations)
    if (Option.isNone(port)) {
      return yield* Effect.fail(new Unavailable({ dependency: "operations" }))
    }
    const found = yield* port.value.invoke({
      name: asked.name,
      type: asked.type,
      parameters: asked.parameters,
      ...(asked.id === undefined ? {} : { id: asked.id })
    })
    return trimmed(found, asked.elements, asked.max)
  })

const idle = (parameters: ReadonlyArray<Pair>, max: number | undefined): string | undefined =>
  parameters.length > 0
    ? "parameters: only an operation takes parameters on a read"
    : max === undefined
      ? undefined
      : "max: only an operation returns a bundle from a read"

const readTool = (args: unknown) =>
  Effect.gen(function* () {
    const asked = yield* decode(ReadArgs, args)
    const parameters = flatten(asked.parameters)
    if (asked.operation !== undefined) {
      return yield* operate({
        name: asked.operation,
        scope: "instance",
        type: asked.type,
        id: asked.id,
        parameters,
        elements: asked.elements,
        max: asked.max ?? DEFAULT_MAX_ENTRIES
      })
    }
    const spare = idle(parameters, asked.max)
    if (spare !== undefined) return yield* reject(spare)
    const engine = yield* FhirEngine
    const resource: FhirResource = yield* engine.read(asked.type, asked.id)
    return succeeded(
      keep(resource as Record<string, unknown>, asked.elements),
      undefined,
      missing(resource as Record<string, unknown>, asked.elements)
    )
  })

const searchTool = (args: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decode(SearchArgs, args)
    const parameters = flatten(decoded.parameters)
    if (decoded.operation !== undefined) {
      if (decoded.cursor !== undefined) {
        return yield* reject("cursor: an operation carries its own continuation")
      }
      return yield* operate({
        name: decoded.operation,
        scope: "type",
        type: decoded.type,
        parameters,
        elements: decoded.elements,
        max: decoded.max
      })
    }
    let offset = 0
    if (decoded.cursor !== undefined) {
      const position = redeem(decoded.cursor, decoded.type, parameters)
      if (position === undefined) {
        return yield* reject("continuation token not accepted")
      }
      offset = position.offset
    }
    const engine = yield* FhirEngine
    const found: Bundle = yield* engine.search({
      type: decoded.type,
      parameters,
      offset,
      limit: decoded.max
    })
    const all = found.entry ?? []
    const entries = all.slice(0, decoded.max)
    const total = found.total ?? offset + all.length
    const shown = entries.map((entry) => ({
      ...entry,
      resource: keep(entry.resource as Record<string, unknown>, decoded.elements) as FhirResource
    }))
    const gaps = missingIn(
      all.map((entry) => entry.resource as Record<string, unknown>),
      decoded.elements
    )
    const next = offset + entries.length
    const more = next < total
    const bundle = {
      ...found,
      total,
      entry: shown,
      ...(more
        ? { link: [{ relation: "next", url: issue({ type: decoded.type, parameters, offset: next }) }] }
        : {})
    }
    return more
      ? succeeded(bundle, { returned: next, of: total }, gaps)
      : succeeded(bundle, undefined, gaps)
  })

const capabilitiesTool = (args: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decode(CapabilitiesArgs, args)
    const engine = yield* FhirEngine
    const resourceTypes = yield* engine.resourceTypes()
    if (decoded.type === undefined) return succeeded({ resourceTypes })
    const parameters = yield* engine.searchParameters(decoded.type)
    return succeeded({ resourceTypes, type: decoded.type, parameters, operations: named() })
  })

const bound = Effect.serviceOption(Deadline).pipe(
  Effect.map(
    Option.match({
      onNone: () => DEFAULT_DEADLINE_MS,
      onSome: (one: Bound) => one.millis
    })
  )
)

export const call = (name: string, args: unknown): Effect.Effect<ToolResult, never, FhirEngine> =>
  Effect.gen(function* () {
    if (!names.has(name)) {
      return failed(new Rejected({ reason: `unknown tool: ${name}` }))
    }
    const millis = yield* bound
    let admission: Admission = { kind: "permit", release: Effect.void }
    const maybeLimiter = yield* Effect.serviceOption(Limiter)
    if (Option.isSome(maybeLimiter)) {
      const maybeSession = yield* Effect.serviceOption(CurrentSession)
      const sessionId = Option.isSome(maybeSession) ? maybeSession.value.id : "anonymous"
      admission = yield* maybeLimiter.value.check(name, sessionId)
    }
    if (admission.kind === "refused") {
      return limited(name, admission.retryAfterSeconds)
    }
    const chosen =
      name === "read" ? readTool(args) : name === "search" ? searchTool(args) : capabilitiesTool(args)
    return yield* chosen.pipe(
      Effect.catchAll((failure) => Effect.succeed(failed(failure))),
      Effect.timeoutTo({
        duration: Duration.millis(millis),
        onTimeout: () => expired(millis),
        onSuccess: (result: ToolResult) => result
      }),
      Effect.ensuring(admission.release)
    )
  })
