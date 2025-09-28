import { describe, expect, it, vi } from "vitest"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  TestClock,
  TestContext
} from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { BUDGET, connections, pool, retryAfter, stalled } from "./pool.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const turn = Effect.promise(
  () => new Promise<void>((done) => setImmediate(done))
)

const spin = (times = 12) =>
  Effect.forEach(Array.from({ length: times }), () => turn, { discard: true })

const run = <A, E>(work: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(work.pipe(Effect.provide(TestContext.TestContext)))

const failed = <A, E>(result: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return result.cause.error
  }
  throw new Error("expected a failure")
}

const waiting = <A, E>(fiber: Fiber.RuntimeFiber<A, E>) =>
  Effect.map(Fiber.poll(fiber), Option.isNone)

const one = { size: 1, reserved: 0, waitMs: 2_000, retryAfterMs: 250 }
const two = { size: 2, reserved: 1, waitMs: 1_000, retryAfterMs: 100 }

const ask = (connection: DuckDBConnection, sql: string) =>
  Effect.promise(async () => {
    const reader = await connection.runAndReadAll(sql)
    return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
  })

describe("connection pool", () => {
  it("hands an item out and takes it back", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([7, 8], "store", one)
        expect(yield* held.use("read", (item) => Effect.succeed(item))).toBe(7)
        expect(yield* held.census).toEqual({ free: 2, writing: 0, waiting: 0 })
      })
    ))

  it("waits for a stalled holder and then fails with a retry hint", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([1], "store", one)
        const block = yield* Deferred.make<void>()
        const holder = yield* Effect.fork(
          held.use("read", () => Deferred.await(block))
        )
        yield* spin()
        expect((yield* held.census).free).toBe(0)
        const late = yield* Effect.fork(
          held.use("read", (item) => Effect.succeed(item))
        )
        yield* spin()
        expect((yield* held.census).waiting).toBe(1)
        yield* TestClock.adjust(one.waitMs - 1)
        yield* spin()
        expect(yield* waiting(late)).toBe(true)
        yield* TestClock.adjust(1)
        yield* spin()
        const outcome = failed(yield* Fiber.await(late))
        expect(outcome._tag).toBe("Unavailable")
        expect(retryAfter(outcome)).toBe(one.retryAfterMs)
        expect((yield* held.census).waiting).toBe(0)
        yield* Deferred.succeed(block, undefined)
        yield* Fiber.join(holder)
        expect((yield* held.census).free).toBe(1)
      })
    ))

  it("serves a waiter as soon as an item comes back", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([1], "store", one)
        const block = yield* Deferred.make<void>()
        const holder = yield* Effect.fork(
          held.use("read", () => Deferred.await(block))
        )
        yield* spin()
        const late = yield* Effect.fork(
          held.use("read", (item) => Effect.succeed(item * 5))
        )
        yield* spin()
        yield* TestClock.adjust(one.waitMs - 500)
        yield* Deferred.succeed(block, undefined)
        yield* Fiber.join(holder)
        yield* spin()
        expect(yield* Fiber.join(late)).toBe(5)
      })
    ))

  it("answers a read while writers hold and queue behind", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([1, 2], "store", two)
        const block = yield* Deferred.make<void>()
        const writer = yield* Effect.fork(
          held.use("write", () => Deferred.await(block))
        )
        yield* spin()
        expect(yield* held.census).toEqual({ free: 1, writing: 1, waiting: 0 })
        const queued = yield* Effect.fork(
          held.use("write", (item) => Effect.succeed(item))
        )
        yield* spin()
        expect((yield* held.census).waiting).toBe(1)
        const answered = yield* held.use("read", (item) => Effect.succeed(item))
        expect(answered).toBe(2)
        expect(yield* waiting(queued)).toBe(true)
        yield* TestClock.adjust(two.waitMs)
        yield* spin()
        const outcome = failed(yield* Fiber.await(queued))
        expect(retryAfter(outcome)).toBe(two.retryAfterMs)
        yield* Deferred.succeed(block, undefined)
        yield* Fiber.join(writer)
        expect(yield* held.census).toEqual({ free: 2, writing: 0, waiting: 0 })
      })
    ))

  it("gives the item back when a waiting caller is interrupted", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([1], "store", one)
        const block = yield* Deferred.make<void>()
        const holder = yield* Effect.fork(
          held.use("read", () => Deferred.await(block))
        )
        yield* spin()
        const late = yield* Effect.fork(
          held.use("read", (item) => Effect.succeed(item))
        )
        yield* spin()
        expect((yield* held.census).waiting).toBe(1)
        yield* Fiber.interrupt(late)
        yield* spin()
        expect((yield* held.census).waiting).toBe(0)
        yield* Deferred.succeed(block, undefined)
        yield* Fiber.join(holder)
        expect((yield* held.census).free).toBe(1)
      })
    ))

  it("releases the item when the work itself fails", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([1], "store", one)
        const outcome = yield* Effect.exit(
          held.use("write", () => Effect.fail(new Rejected({ reason: "no" })))
        )
        expect(failed(outcome)._tag).toBe("Rejected")
        expect(yield* held.census).toEqual({ free: 1, writing: 0, waiting: 0 })
      })
    ))

  it("holds an item for the life of a scope and gives it back at the close", () =>
    run(
      Effect.gen(function* () {
        const held = yield* pool([7, 8], "store", one)
        expect(yield* Effect.scoped(held.take("write"))).toBe(7)
        expect((yield* held.census).free).toBe(2)
        expect((yield* held.census).writing).toBe(0)
      })
    ))

  it("refuses a holder kept waiting past the budget and says when to retry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const quick = { size: 1, reserved: 0, waitMs: 20, retryAfterMs: 40 }
        const held = yield* pool([1], "store", quick)
        const block = yield* Deferred.make<void>()
        const holder = yield* Effect.fork(
          held.use("read", () => Deferred.await(block))
        )
        yield* spin()
        const late = yield* Effect.fork(Effect.scoped(held.take("write")))
        yield* spin()
        expect((yield* held.census).waiting).toBe(1)
        const outcome = failed(yield* Fiber.await(late))
        expect(outcome._tag).toBe("Unavailable")
        expect(retryAfter(outcome)).toBe(quick.retryAfterMs)
        yield* Deferred.succeed(block, undefined)
        yield* Fiber.join(holder)
      })
    ))

  it("reads a retry hint only where one was written", () => {
    const hinted = stalled("store", 750) as Failure
    expect(retryAfter(hinted)).toBe(750)
    expect(retryAfter(new Unavailable({ dependency: "store" }))).toBeUndefined()
    expect(retryAfter(new Rejected({ reason: "no" }))).toBeUndefined()
  })

  it("declares a budget that reserves capacity for reads", () => {
    expect(BUDGET.size).toBeGreaterThan(BUDGET.reserved)
    expect(BUDGET.reserved).toBeGreaterThan(0)
    expect(BUDGET.waitMs).toBeGreaterThan(0)
    expect(BUDGET.retryAfterMs).toBeGreaterThan(0)
  })

  it("answers a read on a real store while a writer stalls", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* connections(":memory:", two)
          const block = yield* Deferred.make<void>()
          const ready = yield* Deferred.make<void>()
          const writer = yield* Effect.fork(
            held.use("write", (connection) =>
              Effect.zipRight(
                ask(connection, "create table probe (n integer)"),
                Effect.zipRight(
                  Deferred.succeed(ready, undefined),
                  Deferred.await(block)
                )
              )
            )
          )
          yield* Deferred.await(ready)
          expect((yield* held.census).writing).toBe(1)
          const rows = yield* held.use("read", (connection) =>
            ask(connection, "select count(*) as n from probe")
          )
          expect(Number(rows[0]?.["n"])).toBe(0)
          yield* Deferred.succeed(block, undefined)
          yield* Fiber.join(writer)
          expect((yield* held.census).free).toBe(2)
        })
      )
    ))
})
