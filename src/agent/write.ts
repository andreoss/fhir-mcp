import { Context, Effect, ParseResult, Schema } from "effect"
import type { FhirResource } from "../core/engine.js"
import {
  Rules,
  Versions,
  conditionalCreate,
  conditionalPatch,
  conditionalRemove,
  conditionalUpdate,
  create,
  patch,
  remove,
  update
} from "../core/interactions.js"
import type { Criteria } from "../core/interactions.js"
import { Forbidden, Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { check, outcome } from "../model/validate.js"
import { record } from "./audit.js"
import type { Entry } from "./audit.js"
import type { ToolAnnotations, ToolResult, ToolSpec } from "./tools.js"

export interface Capabilities {
  readonly write: boolean
  readonly correlation: string
  readonly token?: string
}

export class Grant extends Context.Tag("AgentWriteGrant")<Grant, Capabilities>() {}

export interface Ledger {
  readonly note: (entry: Entry) => Effect.Effect<void>
}

export class Journal extends Context.Tag("AgentWriteJournal")<Journal, Ledger>() {}

type Broken = Failure | OperationOutcome

type Verdict = "success" | "refused" | "failed"

const TYPE = /^[A-Z][A-Za-z]{1,63}$/
const ID = /^[A-Za-z0-9\-.]{1,64}$/

const ResourceType = Schema.String.pipe(Schema.pattern(TYPE)).annotations({
  message: () => "type: expected a resource type name"
})

const Id = Schema.String.pipe(Schema.pattern(ID)).annotations({
  message: () => "id: expected a resource id"
})

const Body = Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
  message: () => "body: expected a resource object"
})

const Version = Schema.String.pipe(Schema.pattern(/^(W\/)?"?[0-9]+"?$/)).annotations({
  message: () => "version: expected a version"
})

const Where = Schema.optionalWith(
  Schema.Record({ key: Schema.String, value: Schema.String }),
  { default: () => ({}) }
)

const Mode = Schema.optionalWith(Schema.Literal("soft", "hard"), {
  default: () => "soft" as const
})

const CreateArgs = Schema.Struct({
  type: ResourceType,
  body: Body,
  id: Schema.optional(Id),
  criteria: Where
})

const UpdateArgs = Schema.Struct({
  type: ResourceType,
  body: Body,
  id: Schema.optional(Id),
  criteria: Where,
  version: Schema.optional(Version)
})

const DeleteArgs = Schema.Struct({
  type: ResourceType,
  id: Schema.optional(Id),
  criteria: Where,
  mode: Mode
})

const PatchArgs = Schema.Struct({
  type: ResourceType,
  patch: Schema.Unknown,
  id: Schema.optional(Id),
  criteria: Where,
  version: Schema.optional(Version)
})

const destructive = (idempotentHint: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint,
  openWorldHint: true
})

const typeProperty = { type: "string", description: "Resource type name." }

const idProperty = {
  type: "string",
  description: "Logical id of the resource. Omit when criteria select it."
}

const bodyProperty = {
  type: "object",
  description: "The resource to write, carrying its own resourceType."
}

const criteriaProperty = {
  type: "object",
  description: "Search parameter names and values selecting one resource."
}

const versionProperty = {
  type: "string",
  description: "Version the caller expects; the write is refused when it moved on."
}

export const writeTools: ReadonlyArray<ToolSpec> = [
  {
    name: "create",
    description: "Store a new resource, optionally only when criteria select none.",
    inputSchema: {
      type: "object",
      properties: {
        type: typeProperty,
        body: bodyProperty,
        id: idProperty,
        criteria: criteriaProperty
      },
      required: ["type", "body"]
    },
    annotations: destructive(false)
  },
  {
    name: "update",
    description: "Replace one resource with the body given, creating it when absent.",
    inputSchema: {
      type: "object",
      properties: {
        type: typeProperty,
        body: bodyProperty,
        id: idProperty,
        criteria: criteriaProperty,
        version: versionProperty
      },
      required: ["type", "body"]
    },
    annotations: destructive(true)
  },
  {
    name: "delete",
    description: "Remove one resource, by id or by criteria that select one.",
    inputSchema: {
      type: "object",
      properties: {
        type: typeProperty,
        id: idProperty,
        criteria: criteriaProperty,
        mode: { type: "string", description: "soft keeps history, hard purges it." }
      },
      required: ["type"]
    },
    annotations: destructive(true)
  },
  {
    name: "patch",
    description: "Apply a patch document to one resource, all of it or none.",
    inputSchema: {
      type: "object",
      properties: {
        type: typeProperty,
        patch: { type: "object", description: "A pointer or element patch document." },
        id: idProperty,
        criteria: criteriaProperty,
        version: versionProperty
      },
      required: ["type", "patch"]
    },
    annotations: destructive(false)
  }
]

const text = (
  value: unknown
): ReadonlyArray<{ readonly type: "text"; readonly text: string }> => [
  { type: "text", text: JSON.stringify(value) }
]

const failed = (found: OperationOutcome): ToolResult => ({
  content: text(found),
  isError: true
})

const succeeded = (value: unknown): ToolResult => ({
  content: text(value),
  isError: false
})

const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((problem) =>
      problem.path.length > 0
        ? `${problem.path.join(".")}: ${problem.message}`
        : problem.message
    )
    .join("; ")

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error): Broken => new Rejected({ reason: reasons(error) }))
  )

const sound = (type: string, body: unknown): Effect.Effect<FhirResource, Broken> =>
  Effect.suspend(() => {
    const found = check(type, body)
    return found.length === 0
      ? Effect.succeed(body as FhirResource)
      : Effect.fail(outcome(found))
  })

const pairs = (where: { readonly [key: string]: string }): Criteria =>
  Object.entries(where)

const targeted = (id: string | undefined): Effect.Effect<string, Broken> =>
  id === undefined
    ? Effect.fail(
      new Rejected({ reason: "id: expected a resource id or criteria selecting one" })
    )
    : Effect.succeed(id)

type Tool = (args: unknown) => Effect.Effect<unknown, Broken, Versions | Rules>

const createTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(CreateArgs, args)
    const body = yield* sound(asked.type, asked.body)
    const where = pairs(asked.criteria)
    const done = where.length > 0
      ? yield* conditionalCreate(asked.type, body, where)
      : yield* create(asked.type, body, asked.id)
    return done.resource
  })

const updateTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(UpdateArgs, args)
    const body = yield* sound(asked.type, asked.body)
    const where = pairs(asked.criteria)
    if (where.length > 0) {
      const done = yield* conditionalUpdate(asked.type, body, where, asked.version)
      return done.resource
    }
    const id = yield* targeted(asked.id)
    const done = yield* update(asked.type, id, body, asked.version)
    return done.resource
  })

const deleteTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(DeleteArgs, args)
    const where = pairs(asked.criteria)
    if (where.length > 0) return yield* conditionalRemove(asked.type, where, asked.mode)
    const id = yield* targeted(asked.id)
    return yield* remove(asked.type, id, asked.mode)
  })

const patchTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(PatchArgs, args)
    const where = pairs(asked.criteria)
    if (where.length > 0) {
      const done = yield* conditionalPatch(
        asked.type,
        where,
        asked.patch,
        asked.version
      )
      return done.resource
    }
    const id = yield* targeted(asked.id)
    const done = yield* patch(asked.type, id, asked.patch, asked.version)
    return done.resource
  })

const pick = (name: string): Tool | undefined =>
  name === "create"
    ? createTool
    : name === "update"
    ? updateTool
    : name === "delete"
    ? deleteTool
    : name === "patch"
    ? patchTool
    : undefined

const outcomeOf = (broken: Broken): OperationOutcome =>
  "resourceType" in broken ? broken : toOutcome(broken)

const REFUSALS = new Set(["invalid", "forbidden", "conflict"])

const verdictOf = (found: OperationOutcome): Verdict =>
  found.issue.some((one) => REFUSALS.has(one.code)) ? "refused" : "failed"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface Facts {
  readonly type?: string
  readonly id?: string
  readonly parameters?: ReadonlyArray<string>
}

const facts = (args: unknown): Facts => {
  if (!isRecord(args)) return {}
  const type = args["type"]
  const id = args["id"]
  const where = args["criteria"]
  return {
    ...(typeof type === "string" && TYPE.test(type) ? { type } : {}),
    ...(typeof id === "string" && ID.test(id) ? { id } : {}),
    ...(isRecord(where) ? { parameters: Object.keys(where) } : {})
  }
}

export const callWrite = (
  name: string,
  args: unknown
): Effect.Effect<ToolResult, never, Versions | Rules | Grant | Journal> =>
  Effect.gen(function* () {
    const grant = yield* Grant
    const journal = yield* Journal
    const tell = (verdict: Verdict) =>
      journal.note(
        record({
          correlation: grant.correlation,
          tool: name,
          outcome: verdict,
          ...facts(args),
          ...(grant.token === undefined ? {} : { token: grant.token })
        })
      )
    const chosen = pick(name)
    if (chosen === undefined) {
      yield* tell("refused")
      return failed(toOutcome(new Rejected({ reason: `unknown tool: ${name}` })))
    }
    if (!grant.write) {
      yield* tell("refused")
      const denied = new Forbidden({ action: `${name}: the grant is read-only` })
      return failed(toOutcome(denied))
    }
    const answer = yield* chosen(args).pipe(
      Effect.map((value) => ({
        result: succeeded(value),
        verdict: "success" as Verdict
      })),
      Effect.catchAll((broken) => {
        const found = outcomeOf(broken)
        return Effect.succeed({ result: failed(found), verdict: verdictOf(found) })
      })
    )
    yield* tell(answer.verdict)
    return answer.result
  })
