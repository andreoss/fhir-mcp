import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Conflict, Forbidden, NotFound } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { known } from "../obs/correlation.js"
import type { Entry, Outcome } from "./chain.js"

export type Action =
  | "export"
  | "import"
  | "reindex"
  | "bulk-delete"
  | "bulk-update"

export interface Grant {
  readonly subject: string
  readonly actions: ReadonlyArray<Action>
  readonly types: ReadonlyArray<string>
}

export interface Ask {
  readonly action: Action
  readonly type: string
}

export interface Slip {
  readonly id: string
  readonly owner: string
  readonly action: Action
  readonly type: string
}

export type Sink = (entry: Entry) => Effect.Effect<unknown, Failure>

export interface Desk {
  readonly submit: (
    grant: Grant,
    ask: Ask
  ) => Effect.Effect<Slip, Failure>
  readonly finish: (
    id: string,
    result: string
  ) => Effect.Effect<void, Failure>
  readonly result: (
    grant: Grant,
    id: string
  ) => Effect.Effect<string, Failure>
}

interface Held {
  readonly slip: Slip
  result: string | undefined
}

export const covers = (grant: Grant, ask: Ask): boolean =>
  grant.actions.includes(ask.action) &&
  (grant.types.includes("*") || grant.types.includes(ask.type))

export const desk = (sink: Sink): Desk => {
  const held = new Map<string, Held>()

  const note = (
    actor: string,
    action: string,
    resource: string,
    outcome: Outcome
  ) =>
    Effect.flatMap(known, (correlation) =>
      sink({ actor, action, resource, outcome, correlation })
    )

  const refuse = <A>(
    actor: string,
    action: string,
    resource: string,
    failure: Failure
  ): Effect.Effect<A, Failure> =>
    Effect.zipRight(
      note(actor, action, resource, "refused"),
      Effect.fail(failure)
    )

  const submit = (grant: Grant, ask: Ask) =>
    Effect.gen(function* () {
      const resource = `${ask.type}/$${ask.action}`
      if (!covers(grant, ask)) {
        return yield* refuse<Slip>(
          grant.subject,
          "job-submit",
          resource,
          new Forbidden({ action: `${ask.action} on ${ask.type}` })
        )
      }
      const slip: Slip = {
        id: randomUUID(),
        owner: grant.subject,
        action: ask.action,
        type: ask.type
      }
      held.set(slip.id, { slip, result: undefined })
      yield* note(grant.subject, "job-submit", resource, "success")
      return slip
    })

  const finish = (id: string, result: string) =>
    Effect.suspend(() => {
      const job = held.get(id)
      if (job === undefined) {
        return Effect.fail(new NotFound({ type: "job", id }))
      }
      job.result = result
      return Effect.void
    })

  const result = (grant: Grant, id: string) =>
    Effect.gen(function* () {
      const resource = `job/${id}`
      const job = held.get(id)
      if (job === undefined) {
        return yield* refuse<string>(
          grant.subject,
          "job-result",
          resource,
          new NotFound({ type: "job", id })
        )
      }
      const owned = job.slip.owner === grant.subject
      if (!owned || !covers(grant, job.slip)) {
        return yield* refuse<string>(
          grant.subject,
          "job-result",
          resource,
          new Forbidden({ action: `read the result of job ${id}` })
        )
      }
      if (job.result === undefined) {
        return yield* refuse<string>(
          grant.subject,
          "job-result",
          resource,
          new Conflict({ reason: `job ${id} has produced no result yet` })
        )
      }
      yield* note(grant.subject, "job-result", resource, "success")
      return job.result
    })

  return { submit, finish, result }
}
