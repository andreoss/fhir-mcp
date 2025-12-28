import { Effect, Schema } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { Catalog } from "../versions/port.js"
import { versionOf } from "../versions/catalog.js"
import { compartmentsOf, definitionIn } from "../versions/version.js"
import { reasons } from "./redact.js"
import { VERSION_RULES } from "./rules.js"
import type { ToolAnnotations, ToolResult, ToolSpec } from "./tools.js"

const Name = Schema.String.pipe(
  Schema.pattern(/^[0-9][0-9A-Za-z.-]{0,31}$/)
).annotations({ message: () => "version: expected a version name" })

const Type = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Za-z]{1,63}$/)
).annotations({ message: () => "type: expected a resource type name" })

const Described = Schema.Struct({ version: Name, type: Schema.optional(Type) })

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

export const versionTools: ReadonlyArray<ToolSpec> = [
  {
    name: "versions",
    description:
      "Name the FHIR versions this build serves and which one is the default. " +
      VERSION_RULES,
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: readOnly
  },
  {
    name: "version",
    description:
      "Read one served version: its types, or for one type its elements, " +
      "search parameters and compartments. " +
      VERSION_RULES,
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "Name of the version, as versions answers it." },
        type: { type: "string", description: "Resource type to describe, when one is asked." }
      },
      required: ["version"]
    },
    annotations: readOnly
  }
]

const text = (value: unknown): ReadonlyArray<{ readonly type: "text"; readonly text: string }> => [
  { type: "text", text: JSON.stringify(value) }
]

const refused = (found: OperationOutcome): ToolResult => ({ content: text(found), isError: true })

const answered = (found: unknown): ToolResult => ({ content: text(found), isError: false })

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error): Failure => new Rejected({ reason: reasons(error) }))
  )

const listed = (args: unknown): Effect.Effect<ToolResult, Failure, Catalog> =>
  Effect.gen(function* () {
    yield* decode(Schema.Struct({}), args)
    const all = yield* Catalog
    return answered({ versions: all.map((one) => one.name), default: all[0]?.name })
  })

const described = (args: unknown): Effect.Effect<ToolResult, Failure, Catalog> =>
  Effect.gen(function* () {
    const asked = yield* decode(Described, args)
    const all = yield* Catalog
    const version = yield* versionOf(asked.version, all)
    if (asked.type === undefined) {
      return answered({ version: version.name, types: version.types })
    }
    const held = yield* definitionIn(version, asked.type)
    return answered({
      version: version.name,
      type: asked.type,
      elements: Object.keys(held.elements).sort(),
      parameters: Object.keys(version.params[asked.type] ?? {}).sort(),
      compartments: compartmentsOf(version, asked.type)
    })
  })

export const callVersion = (
  name: string,
  args: unknown
): Effect.Effect<ToolResult, never, Catalog> =>
  Effect.gen(function* () {
    const run = name === "versions" ? listed : name === "version" ? described : undefined
    if (run === undefined) {
      return refused(toOutcome(new Rejected({ reason: `unknown tool: ${name}` })))
    }
    return yield* run(args).pipe(
      Effect.catchAll((failure: Failure) => Effect.succeed(refused(toOutcome(failure))))
    )
  })
