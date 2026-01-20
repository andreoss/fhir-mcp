import { Effect, Schema } from "effect"
import type { Criteria } from "../core/interactions.js"
import { Versions } from "../core/interactions.js"
import { Forbidden, Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { Incumbency } from "../replace/port.js"
import { sealed } from "../replace/incumbent.js"
import type { Incumbent } from "../replace/incumbent.js"
import { survey, tally } from "../replace/survey.js"
import { migrate, named } from "../replace/migrate.js"
import { readerOf, shadow, side } from "../replace/shadow.js"
import type { Request } from "../replace/shadow.js"
import { report } from "../replace/diff.js"
import { AGREED, check } from "../replace/gate.js"
import { Grant } from "./write.js"
import { reasons } from "./redact.js"
import { REPLACE_RULES } from "./rules.js"
import type { ToolAnnotations, ToolResult, ToolSpec } from "./tools.js"

const Path = Schema.String.pipe(
  Schema.minLength(1),
  Schema.pattern(/^[^"'`;]+$/)
).annotations({ message: () => "path: expected a store path" })

const Type = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Za-z]{1,63}$/)
).annotations({ message: () => "type: expected a resource type name" })

const Asked = Schema.Struct({
  kind: Schema.Literal("read", "search"),
  type: Type,
  id: Schema.optional(Schema.String),
  criteria: Schema.optional(Schema.Array(Schema.Tuple(Schema.String, Schema.String)))
})

const Of = Schema.Struct({ path: Path })

const Surveyed = Schema.Struct({ path: Path })

const Run = Schema.Struct({
  path: Path,
  request: Schema.Array(Asked).pipe(Schema.minItems(1), Schema.maxItems(50))
})

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

const intoThis: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
}

export const replaceTools: ReadonlyArray<ToolSpec> = [
  {
    name: "replace-survey",
    description:
      "Read the schema, resources, versions and search state of another store " +
      "of this product, without writing to it. " +
      REPLACE_RULES,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the store file to read as the incumbent." }
      },
      required: ["path"]
    },
    annotations: readOnly
  },
  {
    name: "replace-migrate",
    description:
      "Migrate another store of this product into this one, accounting for " +
      "every resource, version and delete marker, and name what did not " +
      "transfer. " +
      REPLACE_RULES,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the store file to migrate from." }
      },
      required: ["path"]
    },
    annotations: intoThis
  },
  {
    name: "replace-shadow",
    description:
      "Serve the same reads and searches from another store of this product " +
      "and from this one, compare the answers, and hold them against the " +
      "agreed acceptance gate. " +
      REPLACE_RULES,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the store file to read as the incumbent." },
        request: {
          type: "array",
          description: "Requests to serve on both sides.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "read or search" },
              type: { type: "string", description: "Resource type to ask for." },
              id: { type: "string", description: "Id to read, when the kind is read." },
              criteria: {
                type: "array",
                description: "Parameter pairs to search by, when the kind is search."
              }
            },
            required: ["kind", "type"]
          }
        }
      },
      required: ["path", "request"]
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

type Requested = Schema.Schema.Type<typeof Asked>

type Held = Incumbency | Versions

const opened = (path: string): Effect.Effect<Incumbent, Failure, Incumbency> =>
  Effect.flatMap(Incumbency, (open) => Effect.scoped(open(path)))

const surveyed = (args: unknown): Effect.Effect<ToolResult, Failure, Incumbency> =>
  Effect.gen(function* () {
    const asked = yield* decode(Surveyed, args)
    const port = yield* opened(asked.path)
    const found = yield* survey(port)
    return answered({
      schema: { version: found.schema.version, table: found.schema.table.map((one) => one.name) },
      types: found.type,
      tally: tally(found),
      search: found.search
    })
  })

const moved = (args: unknown): Effect.Effect<ToolResult, Failure, Held | Grant> =>
  Effect.gen(function* () {
    const asked = yield* decode(Of, args)
    const grant = yield* Grant
    if (!grant.write) {
      return yield* Effect.fail(
        new Forbidden({ action: "replace.migrate without a write grant" })
      )
    }
    const port = yield* opened(asked.path)
    const target = yield* Versions
    const found = yield* migrate(port, target)
    return answered({ ...found, missed: named(found) })
  })

const asked = (one: Requested): Request =>
  one.kind === "read"
    ? { kind: "read", type: one.type, id: one.id ?? "" }
    : { kind: "search", type: one.type, criteria: (one.criteria ?? []) as Criteria }

const shadowed = (args: unknown): Effect.Effect<ToolResult, Failure, Held> =>
  Effect.gen(function* () {
    const given = yield* decode(Run, args)
    const port = yield* opened(given.path)
    const target = yield* Versions
    const origin = side("incumbent", sealed(port))
    const here = side("served", readerOf(target))
    const run = yield* shadow(origin, here, given.request.map(asked))
    const found = report(run)
    const verdict = yield* check(AGREED, found)
    return answered({
      left: found.left,
      right: found.right,
      of: found.of,
      byKind: found.byKind,
      bySeverity: found.bySeverity,
      divergence: found.divergence.slice(0, 10),
      gate: {
        agreed: verdict.policy.agreed,
        pass: verdict.pass,
        breach: verdict.breach.map((one) => ({ kind: one.kind, count: one.count })),
        reason: verdict.reason
      }
    })
  })

export const callReplace = (
  name: string,
  args: unknown
): Effect.Effect<ToolResult, never, Held | Grant> =>
  Effect.gen(function* () {
    const run =
      name === "replace-survey"
        ? surveyed
        : name === "replace-migrate"
          ? moved
          : name === "replace-shadow"
            ? shadowed
            : undefined
    if (run === undefined) {
      return refused(toOutcome(new Rejected({ reason: `unknown tool: ${name}` })))
    }
    return yield* run(args).pipe(
      Effect.catchAll((failure: Failure) => Effect.succeed(refused(toOutcome(failure))))
    )
  })
