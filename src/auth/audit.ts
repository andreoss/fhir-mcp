import { Context } from "effect"
import { record } from "../agent/audit.js"
import type { Action } from "./scope.js"

export interface Event {
  readonly at: string
  readonly correlation: string
  readonly actor: string
  readonly action: Action
  readonly resource: string
  readonly outcome: "success" | "refused" | "failed"
}

export interface Attempt {
  readonly correlation: string
  readonly action: Action
  readonly type: string
  readonly id?: string | undefined
  readonly outcome: "success" | "refused" | "failed"
  readonly token?: string | undefined
}

export const event = (attempt: Attempt): Event => {
  const entry = record({
    correlation: attempt.correlation,
    tool: attempt.action,
    outcome: attempt.outcome,
    type: attempt.type,
    ...(attempt.id === undefined ? {} : { id: attempt.id }),
    ...(attempt.token === undefined ? {} : { token: attempt.token })
  })
  return {
    at: entry.at,
    correlation: entry.correlation,
    actor: entry.actor,
    action: attempt.action,
    resource: attempt.id === undefined ? attempt.type : `${attempt.type}/${attempt.id}`,
    outcome: attempt.outcome
  }
}

export interface Trail {
  readonly write: (event: Event) => void
}

export class Audit extends Context.Tag("auth/Audit")<Audit, Trail>() {}
