import { Effect, Schema } from "effect"
import { Rules, Versions } from "../core/interactions.js"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { apply } from "../bundle/bundle.js"
import type { Grant as Reach } from "../bundle/bundle.js"
import { Unit } from "../bundle/unit.js"
import { Journal, record, touched, verdict } from "./audit.js"
import { Grant } from "./write.js"
import { reasons } from "./redact.js"
import { WRITE_RULES } from "./rules.js"
import type { ToolAnnotations, ToolResult, ToolSpec } from "./tools.js"

type Broken = Failure | OperationOutcome

type Verdict = "success" | "refused" | "failed"

const Method = Schema.Literal("GET", "POST", "PUT", "DELETE", "PATCH")

const Asked = Schema.Struct({
  method: Method,
  url: Schema.String,
  ifNoneExist: Schema.optional(Schema.String),
  ifMatch: Schema.optional(Schema.String)
})

const Placed = Schema.Struct({
  fullUrl: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.Unknown),
  request: Asked
})

const Width = Schema.Number.pipe(Schema.int(), Schema.between(1, 64))

const BundleArgs = Schema.Struct({
  entry: Schema.Array(Placed),
  width: Schema.optional(Width)
})

const entryProperty = {
  type: "array",
  description:
    "Entries in the order they are applied. Each carries a request with a " +
    "method and a url such as Patient or Patient?identifier=1, and a resource " +
    "when the method writes one."
}

const written: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
}

export const bundleTools: ReadonlyArray<ToolSpec> = [
  {
    name: "transaction",
    description:
      "Apply a bundle as one transaction: every entry is kept or none is. " +
      WRITE_RULES,
    inputSchema: {
      type: "object",
      properties: { entry: entryProperty },
      required: ["entry"]
    },
    annotations: written
  },
  {
    name: "batch",
    description:
      "Apply a bundle as a batch: each entry answers its own outcome and one " +
      "failure does not stop the others. " + WRITE_RULES,
    inputSchema: {
      type: "object",
      properties: { entry: entryProperty },
      required: ["entry"]
    },
    annotations: written
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

const succeeded = (value: unknown): ToolResult => ({ content: text(value), isError: false })

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error): Broken => new Rejected({ reason: reasons(error) }))
  )

const outcomeOf = (broken: Broken): OperationOutcome =>
  "resourceType" in broken ? broken : toOutcome(broken)

const kindOf = (name: string): "transaction" | "batch" | undefined =>
  name === "transaction" ? "transaction" : name === "batch" ? "batch" : undefined

export const callBundle = (
  name: string,
  args: unknown
): Effect.Effect<
  ToolResult,
  never,
  Versions | Rules | Grant | Journal | Unit
> =>
  Effect.gen(function* () {
    const grant = yield* Grant
    const journal = yield* Journal
    const tell = (said: Verdict) =>
      journal.note(
        record({
          correlation: grant.correlation,
          tool: name,
          outcome: said,
          ...touched(args),
          ...(grant.token === undefined ? {} : { token: grant.token })
        })
      )
    const answered = yield* Effect.gen(function* () {
      const kind = kindOf(name)
      if (kind === undefined) {
        return yield* Effect.fail<Broken>(
          new Rejected({ reason: `unknown tool: ${name}` })
        )
      }
      const asked = yield* decode(BundleArgs, args)
      const reach: Reach = { read: true, write: grant.write, types: [] }
      return yield* apply(
        {
          resourceType: "Bundle",
          type: kind,
          entry: asked.entry.map((one) => ({
            request: {
              method: one.request.method,
              url: one.request.url,
              ...(one.request.ifNoneExist === undefined
                ? {}
                : { ifNoneExist: one.request.ifNoneExist }),
              ...(one.request.ifMatch === undefined
                ? {}
                : { ifMatch: one.request.ifMatch })
            },
            ...(one.fullUrl === undefined ? {} : { fullUrl: one.fullUrl }),
            ...(one.resource === undefined ? {} : { resource: one.resource })
          }))
        },
        reach,
        asked.width ?? 4
      )
    }).pipe(
      Effect.map((value) => ({
        result: succeeded(value),
        verdict: "success" as Verdict
      })),
      Effect.catchAll((broken: Broken) => {
        const found = outcomeOf(broken)
        return Effect.succeed({ result: failed(found), verdict: verdict(found) })
      })
    )
    yield* tell(answered.verdict)
    return answered.result
  })
