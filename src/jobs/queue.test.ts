import { describe, expect, it, vi } from "vitest"
import { Effect, Exit, TestClock, TestContext } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Failure } from "../core/outcome.js"
import { open, queueOn } from "./queue.js"
import type { Durable } from "./queue.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const LEASE = 30_000

const run = <A>(work: (queue: Durable) => Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(open(":memory:"), work)).pipe(
      Effect.provide(TestContext.TestContext)
    )
  )

const wired = <A>(
  work: (queue: Durable, sql: DuckDBConnection) => Effect.Effect<A, Failure>
): Promise<A> =>
  Effect.runPromise(
    Effect.promise(async () => {
      const instance = await DuckDBInstance.create(":memory:")
      return await instance.connect()
    }).pipe(
      Effect.flatMap((connection) =>
        Effect.flatMap(queueOn(connection), (queue) => work(queue, connection))
      ),
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

const sent = (
  payloads: ReadonlyArray<string>,
  maxAttempts = 3,
  kind = "probe"
) => ({
  kind,
  payloads,
  correlation: "c-1",
  maxAttempts
})

describe("durable queue", () => {
  it("holds every unit a submission splits into", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a", "b", "c"]))
        const job = yield* queue.poll(id)
        expect(job.state).toBe("queued")
        expect(job.total).toBe(3)
        expect(job.pending).toBe(3)
        expect(job.correlation).toBe("c-1")
        const held = yield* queue.inspect(id)
        expect(held.map((unit) => unit.payload).sort()).toEqual(["a", "b", "c"])
      })
    ))

  it("refuses a submission that splits into no work", () =>
    expect(broke((queue) => queue.submit(sent([])))).resolves.toBe("Rejected"))

  it("refuses a submission with no attempt to spend", () =>
    expect(broke((queue) => queue.submit(sent(["a"], 0)))).resolves.toBe(
      "Rejected"
    ))

  it("reports an unknown job as not found", () =>
    expect(broke((queue) => queue.poll("absent"))).resolves.toBe("NotFound"))

  it("leases a unit to one worker and to no other", () =>
    run((queue) =>
      Effect.gen(function* () {
        yield* queue.submit(sent(["a"]))
        const first = yield* queue.lease("w-a", ["probe"], LEASE)
        const second = yield* queue.lease("w-b", ["probe"], LEASE)
        expect(first?.payload).toBe("a")
        expect(first?.attempts).toBe(1)
        expect(second).toBeUndefined()
      })
    ))

  it("leases nothing of a kind it was not asked for", () =>
    run((queue) =>
      Effect.gen(function* () {
        yield* queue.submit(sent(["a"]))
        expect(yield* queue.lease("w-a", ["other"], LEASE)).toBeUndefined()
      })
    ))

  it("hands a dead worker's unit over once the lease expires", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["payload"]))
        const first = yield* queue.lease("w-a", ["probe"], LEASE)
        expect(yield* queue.lease("w-b", ["probe"], LEASE)).toBeUndefined()
        yield* TestClock.adjust(LEASE + 1)
        const second = yield* queue.lease("w-b", ["probe"], LEASE)
        expect(second?.unitId).toBe(first?.unitId)
        expect(second?.payload).toBe("payload")
        expect(second?.attempts).toBe(2)
        expect(second?.lease).not.toBe(first?.lease)
        expect(yield* queue.complete(first!)).toBe(false)
        expect((yield* queue.poll(id)).done).toBe(0)
        expect(yield* queue.complete(second!)).toBe(true)
        const job = yield* queue.poll(id)
        expect(job.state).toBe("done")
        expect(job.done).toBe(1)
      })
    ))

  it("extends a lease for as long as the worker beats", () =>
    run((queue) =>
      Effect.gen(function* () {
        yield* queue.submit(sent(["a"]))
        const unit = yield* queue.lease("w-a", ["probe"], LEASE)
        yield* TestClock.adjust(LEASE - 10_000)
        const beat = yield* queue.beat(unit!, LEASE)
        expect(beat).toEqual({ held: true, cancelling: false })
        yield* TestClock.adjust(LEASE - 10_000)
        expect(yield* queue.lease("w-b", ["probe"], LEASE)).toBeUndefined()
        yield* TestClock.adjust(LEASE)
        expect(yield* queue.lease("w-b", ["probe"], LEASE)).toBeDefined()
        expect((yield* queue.beat(unit!, LEASE)).held).toBe(false)
      })
    ))

  it("tells a beating worker that its job is cancelling", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a"]))
        const unit = yield* queue.lease("w-a", ["probe"], LEASE)
        yield* queue.cancel(id)
        expect(yield* queue.beat(unit!, LEASE)).toEqual({
          held: true,
          cancelling: true
        })
        expect(yield* queue.abandon(unit!)).toBe(true)
        const job = yield* queue.poll(id)
        expect(job.state).toBe("cancelled")
        expect(job.cancelled).toBe(1)
      })
    ))

  it("cancels the units waiting and refuses a finished job", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a", "b"]))
        yield* queue.cancel(id)
        yield* queue.cancel(id)
        const job = yield* queue.poll(id)
        expect(job.state).toBe("cancelled")
        expect(job.cancelling).toBe(true)
        expect(job.cancelled).toBe(2)
        expect(yield* queue.lease("w-a", ["probe"], LEASE)).toBeUndefined()
        const refused = yield* Effect.exit(queue.cancel(id))
        expect(Exit.isFailure(refused)).toBe(false)
      })
    ))

  it("refuses to cancel a job that already finished", () =>
    expect(
      broke((queue) =>
        Effect.gen(function* () {
          const id = yield* queue.submit(sent(["a"]))
          const unit = yield* queue.lease("w-a", ["probe"], LEASE)
          yield* queue.complete(unit!)
          yield* queue.cancel(id)
        })
      )
    ).resolves.toBe("Conflict"))

  it("retries a failed unit up to the bound and says when", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a"], 2))
        const first = yield* queue.lease("w-a", ["probe"], LEASE)
        const retry = yield* queue.fail(first!, "engine said no", 5_000)
        expect(retry).toEqual({ retried: true, retryInMs: 5_000 })
        expect(yield* queue.lease("w-a", ["probe"], LEASE)).toBeUndefined()
        yield* TestClock.adjust(5_000)
        const second = yield* queue.lease("w-a", ["probe"], LEASE)
        expect(second?.attempts).toBe(2)
        const spent = yield* queue.fail(second!, "engine said no", 5_000)
        expect(spent).toEqual({ retried: false, retryInMs: 0 })
        const job = yield* queue.poll(id)
        expect(job.state).toBe("failed")
        expect(job.failed).toBe(1)
        expect(job.detail).toBe("engine said no")
      })
    ))

  it("releases a unit for handover without spending an attempt", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a"]))
        const unit = yield* queue.lease("w-a", ["probe"], LEASE)
        expect(yield* queue.release(unit!)).toBe(true)
        expect(yield* queue.release(unit!)).toBe(false)
        const taken = yield* queue.lease("w-b", ["probe"], LEASE)
        expect(taken?.unitId).toBe(unit?.unitId)
        expect(taken?.attempts).toBe(1)
        expect((yield* queue.poll(id)).state).toBe("running")
      })
    ))

  it("reclaims a stalled unit and cancels one whose job is cancelling", () =>
    run((queue) =>
      Effect.gen(function* () {
        const alive = yield* queue.submit(sent(["a"]))
        const dropped = yield* queue.submit(sent(["b"]))
        yield* queue.lease("w-a", ["probe"], LEASE)
        yield* queue.lease("w-a", ["probe"], LEASE)
        expect(yield* queue.reclaim()).toBe(0)
        yield* queue.cancel(dropped)
        yield* TestClock.adjust(LEASE + 1)
        expect(yield* queue.reclaim()).toBe(2)
        expect((yield* queue.inspect(alive))[0]?.state).toBe("ready")
        expect((yield* queue.inspect(dropped))[0]?.state).toBe("cancelled")
      })
    ))

  it("fails a stalled unit that has no attempt left", () =>
    run((queue) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a"], 1))
        yield* queue.lease("w-a", ["probe"], LEASE)
        yield* TestClock.adjust(LEASE + 1)
        expect(yield* queue.reclaim()).toBe(1)
        const job = yield* queue.poll(id)
        expect(job.state).toBe("failed")
        expect(job.detail).toBe("lease lost")
      })
    ))

  it("purges finished jobs past retention and keeps the live ones", () =>
    run((queue) =>
      Effect.gen(function* () {
        const gone = yield* queue.submit(sent(["a"]))
        const kept = yield* queue.submit(sent(["b"], 3, "other"))
        const unit = yield* queue.lease("w-a", ["probe"], LEASE)
        yield* queue.complete(unit!)
        expect(yield* queue.purge(60_000)).toBe(0)
        yield* TestClock.adjust(60_001)
        expect(yield* queue.purge(60_000)).toBe(1)
        expect((yield* queue.poll(kept)).total).toBe(1)
        expect(yield* queue.inspect(gone)).toEqual([])
      })
    ))

  it("compacts finished payloads and drops orphaned units", () =>
    wired((queue, connection) =>
      Effect.gen(function* () {
        const id = yield* queue.submit(sent(["a"]))
        const unit = yield* queue.lease("w-a", ["probe"], LEASE)
        yield* queue.complete(unit!)
        yield* Effect.promise(() =>
          connection.runAndReadAll(
            `insert into job_unit values
             ('orphan', 'ghost', 'probe', 'c', 'ready', 0, 3, null, null,
              0, 0, 'x', null)`
          )
        )
        expect(yield* queue.defrag()).toBe(2)
        expect(yield* queue.defrag()).toBe(0)
        expect((yield* queue.inspect(id))[0]?.payload).toBe("")
        expect((yield* queue.poll(id)).state).toBe("done")
      })
    ))
})
