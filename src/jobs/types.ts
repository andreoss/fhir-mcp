import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Correlated } from "../obs/correlation.js"

export const KINDS = [
  "import",
  "export",
  "bulk-delete",
  "bulk-update",
  "reindex"
] as const

export type Kind = (typeof KINDS)[number]

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled"

export type UnitState = "ready" | "leased" | "done" | "failed" | "cancelled"

export interface Unit {
  readonly unitId: string
  readonly jobId: string
  readonly kind: string
  readonly correlation: string
  readonly attempts: number
  readonly payload: string
  readonly lease: string
}

export interface Job {
  readonly id: string
  readonly kind: string
  readonly state: JobState
  readonly cancelling: boolean
  readonly total: number
  readonly pending: number
  readonly done: number
  readonly failed: number
  readonly cancelled: number
  readonly submitted: number
  readonly updated: number
  readonly correlation: string
  readonly detail: string | undefined
}

export interface Beat {
  readonly held: boolean
  readonly cancelling: boolean
}

export interface Retry {
  readonly retried: boolean
  readonly retryInMs: number
}

export interface Handler {
  readonly split: (
    request: string
  ) => Effect.Effect<ReadonlyArray<string>, Failure>
  readonly run: (unit: Unit) => Effect.Effect<void, Failure, Correlated>
}

export type Registry = ReadonlyMap<string, Handler>

export const registry = (
  entries: Readonly<Record<string, Handler>>
): Registry => new Map(Object.entries(entries))

export const kindsOf = (held: Registry): ReadonlyArray<string> => [
  ...held.keys()
]

export const handlerOf = (
  held: Registry,
  kind: string
): Effect.Effect<Handler, Failure> => {
  const found = held.get(kind)
  return found === undefined
    ? Effect.fail(new Rejected({ reason: `unknown job kind: ${kind}` }))
    : Effect.succeed(found)
}
