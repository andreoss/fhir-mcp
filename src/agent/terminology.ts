import { Effect, Schema } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { OperationOutcome } from "../core/outcome.js"
import { TerminologyPort } from "../terminology/port.js"
import type { Lookup } from "../terminology/port.js"
import { reasons } from "./redact.js"
import { LOOKUP_RULES } from "./rules.js"
import type { ToolAnnotations, ToolResult, ToolSpec } from "./tools.js"

const System = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z][A-Za-z0-9+.-]{1,15}:\/{0,2}\S{1,255}$/)
).annotations({ message: () => "system: expected a code system url" })

const Code = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)).annotations({
  message: () => "code: expected a code"
})

const Version = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)).annotations({
  message: () => "version: expected a version"
})

const LookupArgs = Schema.Struct({
  system: System,
  code: Code,
  version: Schema.optional(Version)
})

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

export const terminologyTools: ReadonlyArray<ToolSpec> = [
  {
    name: "lookup",
    description: "Resolve a code to its display through the terminology the build loaded. " +
      LOOKUP_RULES,
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "Canonical url of the code system." },
        code: { type: "string", description: "Code to resolve." },
        version: { type: "string", description: "Version of the code system, when pinned." }
      },
      required: ["system", "code"]
    },
    annotations: readOnly
  }
]

const text = (value: unknown): ReadonlyArray<{ readonly type: "text"; readonly text: string }> => [
  { type: "text", text: JSON.stringify(value) }
]

const refused = (found: OperationOutcome): ToolResult => ({ content: text(found), isError: true })

const answered = (found: Lookup): ToolResult => ({ content: text(found), isError: false })

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error): Failure => new Rejected({ reason: reasons(error) }))
  )

const lookupTool = (args: unknown): Effect.Effect<ToolResult, Failure, TerminologyPort> =>
  Effect.gen(function* () {
    const asked = yield* decode(LookupArgs, args)
    const port = yield* TerminologyPort
    const found = yield* port.lookup({
      system: asked.system,
      code: asked.code,
      ...(asked.version === undefined ? {} : { version: asked.version })
    })
    return answered(found)
  })

export const callTerminology = (
  name: string,
  args: unknown
): Effect.Effect<ToolResult, never, TerminologyPort> =>
  Effect.gen(function* () {
    if (name !== "lookup") {
      return refused(toOutcome(new Rejected({ reason: `unknown tool: ${name}` })))
    }
    return yield* lookupTool(args).pipe(
      Effect.catchAll((failure: Failure) => Effect.succeed(refused(toOutcome(failure))))
    )
  })
