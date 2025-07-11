import { Context } from "effect"
import type { Effect } from "effect"
import { createHash } from "node:crypto"
import type { OperationOutcome } from "../core/outcome.js"

export interface Touched {
  readonly type?: string
  readonly id?: string
  readonly parameters?: ReadonlyArray<string>
  readonly elements?: ReadonlyArray<string>
  readonly interaction?: string
}

export interface Attempt extends Touched {
  readonly correlation: string
  readonly tool: string
  readonly outcome: "success" | "refused" | "failed"
  readonly subject?: string
  readonly token?: string
}

export interface Entry extends Touched {
  readonly at: string
  readonly correlation: string
  readonly actor: string
  readonly tool: string
  readonly interaction: string
  readonly outcome: "success" | "refused" | "failed"
  readonly subject?: string
}

export interface Ledger {
  readonly note: (entry: Entry) => Effect.Effect<void>
}

export class Journal extends Context.Tag("AgentJournal")<Journal, Ledger>() {}

export const NONE = "none"

const REFUSALS = new Set(["invalid", "forbidden", "conflict"])

export const verdict = (found: OperationOutcome): "success" | "refused" | "failed" =>
  found.issue.some((one) => REFUSALS.has(one.code ?? "")) ? "refused" : "failed"

const OPERATION = /^\$[a-z][a-z0-9-]{0,62}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const interactionOf = (args: unknown): string | undefined => {
  if (!isRecord(args)) return undefined
  const operation = args["operation"]
  return typeof operation === "string" && OPERATION.test(operation) ? operation : undefined
}

const actorOf = (token: string | undefined): string =>
  token === undefined ? "anonymous" : createHash("sha256").update(token).digest("hex")

export const record = (attempt: Attempt): Entry => ({
  at: new Date().toISOString(),
  correlation: attempt.correlation,
  actor: actorOf(attempt.token),
  tool: attempt.tool,
  interaction: attempt.interaction ?? attempt.tool,
  outcome: attempt.outcome,
  ...(attempt.type === undefined ? {} : { type: attempt.type }),
  ...(attempt.id === undefined ? {} : { id: attempt.id }),
  ...(attempt.parameters === undefined ? {} : { parameters: attempt.parameters }),
  ...(attempt.elements === undefined ? {} : { elements: attempt.elements }),
  ...(attempt.subject === undefined ? {} : { subject: attempt.subject })
})
