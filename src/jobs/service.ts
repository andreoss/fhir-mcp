import { Context, Effect, Layer } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { known } from "../obs/correlation.js"
import type { Durable } from "./queue.js"
import { handlerOf } from "./types.js"
import type { JobState, Registry } from "./types.js"

export interface Counter {
  readonly base: string
  readonly retryAfter: number
  readonly attempts: number
}

export const DESK: Counter = { base: "/jobs", retryAfter: 5, attempts: 3 }

export interface Ticket {
  readonly id: string
  readonly location: string
  readonly retryAfter: number
}

export interface Status {
  readonly id: string
  readonly kind: string
  readonly state: JobState
  readonly location: string
  readonly retryAfter: number | undefined
  readonly total: number
  readonly pending: number
  readonly done: number
  readonly failed: number
  readonly cancelled: number
  readonly detail: string | undefined
}

export interface Desk {
  readonly submit: (
    kind: string,
    request: string
  ) => Effect.Effect<Ticket, Failure>
  readonly status: (id: string) => Effect.Effect<Status, Failure>
  readonly cancel: (id: string) => Effect.Effect<void, Failure>
}

export class Jobs extends Context.Tag("Jobs")<Jobs, Desk>() {}

const settled = new Set<JobState>(["done", "failed", "cancelled"])

export const desk = (
  queue: Durable,
  registry: Registry,
  given: Partial<Counter> = {}
): Desk => {
  const counter: Counter = { ...DESK, ...given }
  const at = (id: string) => `${counter.base}/${id}`

  const submit = (kind: string, request: string) =>
    Effect.gen(function* () {
      const handler = yield* handlerOf(registry, kind)
      const payloads = yield* handler.split(request)
      if (payloads.length === 0) {
        return yield* Effect.fail(
          new Rejected({ reason: `${kind} splits into no unit of work` })
        )
      }
      const correlation = yield* known
      const id = yield* queue.submit({
        kind,
        payloads,
        correlation,
        maxAttempts: counter.attempts
      })
      return { id, location: at(id), retryAfter: counter.retryAfter }
    })

  const status = (id: string) =>
    Effect.map(queue.poll(id), (job) => ({
      id: job.id,
      kind: job.kind,
      state: job.state,
      location: at(job.id),
      retryAfter: settled.has(job.state) ? undefined : counter.retryAfter,
      total: job.total,
      pending: job.pending,
      done: job.done,
      failed: job.failed,
      cancelled: job.cancelled,
      detail: job.detail
    }))

  return { submit, status, cancel: (id: string) => queue.cancel(id) }
}

export const layer = (
  queue: Durable,
  registry: Registry,
  given: Partial<Counter> = {}
): Layer.Layer<Jobs> => Layer.succeed(Jobs, desk(queue, registry, given))
