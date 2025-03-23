import { createHash } from "node:crypto"

export interface Attempt {
  readonly correlation: string
  readonly tool: string
  readonly outcome: "success" | "refused" | "failed"
  readonly type?: string
  readonly id?: string
  readonly parameters?: ReadonlyArray<string>
  readonly token?: string
}

export interface Entry {
  readonly at: string
  readonly correlation: string
  readonly actor: string
  readonly tool: string
  readonly outcome: "success" | "refused" | "failed"
  readonly type?: string
  readonly id?: string
  readonly parameters?: ReadonlyArray<string>
}

const actorOf = (token: string | undefined): string =>
  token === undefined ? "anonymous" : createHash("sha256").update(token).digest("hex")

export const record = (attempt: Attempt): Entry => ({
  at: new Date().toISOString(),
  correlation: attempt.correlation,
  actor: actorOf(attempt.token),
  tool: attempt.tool,
  outcome: attempt.outcome,
  ...(attempt.type === undefined ? {} : { type: attempt.type }),
  ...(attempt.id === undefined ? {} : { id: attempt.id }),
  ...(attempt.parameters === undefined ? {} : { parameters: attempt.parameters })
})
