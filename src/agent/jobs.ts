import { Effect, Option, Schema } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"
import { Jobs } from "../jobs/service.js"
import { KINDS } from "../jobs/types.js"
import { report } from "../bulk/bulk.js"
import { DepotPort } from "../bulk/depot.js"
import { known } from "../obs/correlation.js"
import { Journal, record, touched, verdict } from "./audit.js"
import { reasons } from "./redact.js"
import { JOB_RULES } from "./rules.js"
import type { ToolAnnotations, ToolResult, ToolSpec } from "./tools.js"

type Verdict = "success" | "refused" | "failed"

const Kind = Schema.Literal(...KINDS).annotations({
  message: () => `kind: expected one of ${KINDS.join(", ")}`
})

const Request = Schema.String.pipe(Schema.minLength(1)).annotations({
  message: () => "request: expected the job request document"
})

const JobId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/)
).annotations({ message: () => "id: expected a job id" })

const SubmitArgs = Schema.Struct({ kind: Kind, request: Request })

const JobArgs = Schema.Struct({ id: JobId })

const LINES = 100

const MAX_LINES = 1000

const Path = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)
).annotations({ message: () => "path: expected the path of a sheet" })

const Limit = Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_LINES)).annotations({
  message: () => `limit: expected 1 to ${MAX_LINES} lines`
})

const OutputArgs = Schema.Struct({
  id: JobId,
  path: Schema.optional(Path),
  limit: Schema.optional(Limit)
})

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

const mutating: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
}

const cancelling: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
}

export const jobTools: ReadonlyArray<ToolSpec> = [
  {
    name: "job-submit",
    description:
      "Start an asynchronous job of one of the served kinds and answer with " +
      "where its status is held and when to ask again. job-submit does not " +
      "wait for the job; poll job-status with the id it answers. " + JOB_RULES,
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...KINDS],
          description: "Kind of job to start."
        },
        request: {
          type: "string",
          description:
            'Request document of the job, as json text, such as {"type":"Patient"}.'
        }
      },
      required: ["kind", "request"]
    },
    annotations: mutating
  },
  {
    name: "job-status",
    description:
      "Report the state and progress of one asynchronous job by the id " +
      "job-submit answered. job-status is the only place a job's result " +
      "appears; ask again after the retry hint while the job runs. " + JOB_RULES,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id of the job, as job-submit answered it." }
      },
      required: ["id"]
    },
    annotations: readOnly
  },
  {
    name: "job-cancel",
    description:
      "Ask for one asynchronous job to stop, by the id job-submit answered, " +
      "and report the state the request left behind. job-cancel does not undo " +
      "what the job already wrote. " + JOB_RULES,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id of the job, as job-submit answered it." }
      },
      required: ["id"]
    },
    annotations: cancelling
  },
  {
    name: "job-output",
    description:
      "job-output reports what one asynchronous job wrote, by the id " +
      "job-submit answered: its state and progress, the sheets it produced " +
      "with the rows each one holds, and the path of its failure file when " +
      "it wrote one. Name a path to read the lines of that sheet. " + JOB_RULES,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id of the job, as job-submit answered it." },
        path: {
          type: "string",
          description:
            "Path of one sheet the job wrote, as job-output listed it. " +
            "Reads at most 100 lines unless a limit is given."
        },
        limit: {
          type: "integer",
          description: `Number of lines to read, from 1 to ${MAX_LINES}.`
        }
      },
      required: ["id"]
    },
    annotations: readOnly
  }
]

const text = (value: unknown): ReadonlyArray<{ readonly type: "text"; readonly text: string }> => [
  { type: "text", text: JSON.stringify(value) }
]

const refused = (found: OperationOutcome): ToolResult => ({ content: text(found), isError: true })

const answered = (value: unknown): ToolResult => ({ content: text(value), isError: false })

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args, { errors: "all" }).pipe(
    Effect.mapError((error): Failure => new Rejected({ reason: reasons(error) }))
  )

type Tool = (args: unknown) => Effect.Effect<unknown, Failure, Jobs | DepotPort>

const submitTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(SubmitArgs, args)
    const desk = yield* Jobs
    return yield* desk.submit(asked.kind, asked.request)
  })

const statusTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(JobArgs, args)
    const desk = yield* Jobs
    return yield* desk.status(asked.id)
  })

const cancelTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(JobArgs, args)
    const desk = yield* Jobs
    yield* desk.cancel(asked.id)
    return yield* desk.status(asked.id)
  })

const outputTool: Tool = (args) =>
  Effect.gen(function* () {
    const asked = yield* decode(OutputArgs, args)
    const desk = yield* Jobs
    const depot = yield* DepotPort
    const told = yield* report(desk, depot, asked.id)
    if (asked.path === undefined) return told
    const sheet = told.output.find((one) => one.path === asked.path)
    if (sheet === undefined && asked.path !== told.error) {
      return yield* Effect.fail(
        new Rejected({ reason: `${asked.path} is no sheet of job ${asked.id}` })
      )
    }
    const lines = yield* depot.get(asked.path)
    const bound = asked.limit ?? LINES
    return {
      ...told,
      sheet: {
        path: asked.path,
        rows: sheet?.rows ?? lines.length,
        returned: Math.min(bound, lines.length),
        lines: lines.slice(0, bound)
      }
    }
  })

const pick = (name: string): Tool | undefined =>
  name === "job-submit"
    ? submitTool
    : name === "job-status"
      ? statusTool
      : name === "job-cancel"
        ? cancelTool
        : name === "job-output"
          ? outputTool
          : undefined

export const callJob = (
  name: string,
  args: unknown
): Effect.Effect<ToolResult, never, Jobs | DepotPort> =>
  Effect.gen(function* () {
    const journal = yield* Effect.serviceOption(Journal)
    const correlation = yield* known
    const tell = (outcome: Verdict) =>
      Option.isSome(journal)
        ? journal.value.note(record({ correlation, tool: name, outcome, ...touched(args) }))
        : Effect.void
    const chosen = pick(name)
    if (chosen === undefined) {
      yield* tell("refused")
      return refused(toOutcome(new Rejected({ reason: `unknown tool: ${name}` })))
    }
    const answer = yield* chosen(args).pipe(
      Effect.map((value) => ({
        result: answered(value),
        verdict: "success" as Verdict
      })),
      Effect.catchAll((failure: Failure) => {
        const found = toOutcome(failure)
        return Effect.succeed({ result: refused(found), verdict: verdict(found) })
      })
    )
    yield* tell(answer.verdict)
    return answer.result
  })
