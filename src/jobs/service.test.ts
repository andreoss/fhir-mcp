import { describe, expect, it, vi } from "vitest"
import { Effect, Exit, TestContext } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { edge } from "../obs/correlation.js"
import { open } from "./queue.js"
import type { Durable } from "./queue.js"
import { registry } from "./types.js"
import { DESK, Jobs, desk, layer } from "./service.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const held = <A>(work: (queue: Durable) => Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(open(":memory:"), work)).pipe(
      Effect.provide(TestContext.TestContext)
    )
  )

const broke = <A>(work: (queue: Durable) => Effect.Effect<A, Failure>) =>
  Effect.runPromiseExit(
    Effect.scoped(Effect.flatMap(open(":memory:"), work)).pipe(
      Effect.provide(TestContext.TestContext)
    )
  ).then((result) => {
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      return result.cause.error._tag
    }
    throw new Error("expected a failure")
  })

const kinds = registry({
  export: {
    split: (request) => Effect.succeed(request.split(",")),
    run: () => Effect.void
  },
  import: {
    split: () => Effect.succeed([]),
    run: () => Effect.void
  },
  reindex: {
    split: () => Effect.fail(new Rejected({ reason: "no such type" })),
    run: () => Effect.void
  }
})

describe("job desk", () => {
  it("answers a submission with a status location and a retry hint", () =>
    held((queue) =>
      Effect.gen(function* () {
        const front = desk(queue, kinds)
        const ticket = yield* front.submit("export", "a,b")
        expect(ticket.location).toBe(`${DESK.base}/${ticket.id}`)
        expect(ticket.retryAfter).toBe(DESK.retryAfter)
        const status = yield* front.status(ticket.id)
        expect(status.state).toBe("queued")
        expect(status.total).toBe(2)
        expect(status.retryAfter).toBe(DESK.retryAfter)
        expect(status.location).toBe(ticket.location)
      })
    ))

  it("refuses a kind no handler is registered for", () =>
    expect(
      broke((queue) => desk(queue, kinds).submit("convert", "a"))
    ).resolves.toBe("Rejected"))

  it("refuses a request that splits into no work", () =>
    expect(
      broke((queue) => desk(queue, kinds).submit("import", "a"))
    ).resolves.toBe("Rejected"))

  it("passes on the reason an orchestrator refused the request", () =>
    expect(
      broke((queue) => desk(queue, kinds).submit("reindex", "a"))
    ).resolves.toBe("Rejected"))

  it("polls by id and drops the retry hint once the job finished", () =>
    held((queue) =>
      Effect.gen(function* () {
        const front = desk(queue, kinds)
        const ticket = yield* front.submit("export", "a")
        const unit = yield* queue.lease("w-a", ["export"], 10_000)
        yield* queue.complete(unit!)
        const status = yield* front.status(ticket.id)
        expect(status.state).toBe("done")
        expect(status.done).toBe(1)
        expect(status.retryAfter).toBeUndefined()
        expect(status.detail).toBeUndefined()
      })
    ))

  it("cancels by id", () =>
    held((queue) =>
      Effect.gen(function* () {
        const front = desk(queue, kinds)
        const ticket = yield* front.submit("export", "a,b")
        yield* front.cancel(ticket.id)
        const status = yield* front.status(ticket.id)
        expect(status.state).toBe("cancelled")
        expect(status.cancelled).toBe(2)
      })
    ))

  it("reports an unknown id as not found", () =>
    expect(broke((queue) => desk(queue, kinds).status("absent"))).resolves.toBe(
      "NotFound"
    ))

  it("carries the correlation of the caller into the job", () =>
    held((queue) =>
      Effect.gen(function* () {
        const front = desk(queue, kinds)
        const ticket = yield* edge(front.submit("export", "a"), "req-7")
        expect((yield* queue.poll(ticket.id)).correlation).toBe("req-7")
      })
    ))

  it("is supplied as a layer", () =>
    held((queue) =>
      Effect.gen(function* () {
        const ticket = yield* Jobs.pipe(
          Effect.flatMap((front) => front.submit("export", "a")),
          Effect.provide(layer(queue, kinds, { retryAfter: 2 }))
        )
        expect(ticket.retryAfter).toBe(2)
      })
    ))
})
