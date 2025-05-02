import { describe, expect, it, vi } from "vitest"
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Ref,
  TestClock,
  TestContext
} from "effect"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import * as correlation from "../obs/correlation.js"
import type { Correlated } from "../obs/correlation.js"
import { open } from "./queue.js"
import type { Durable } from "./queue.js"
import { registry } from "./types.js"
import type { Handler, Unit } from "./types.js"
import { SHIFT, start, workerName } from "./worker.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const turn = Effect.promise(
  () => new Promise<void>((done) => setImmediate(done))
)

const settle = (
  check: Effect.Effect<boolean, Failure>,
  step = 250,
  tries = 200
) =>
  Effect.gen(function* () {
    for (let round = 0; round < tries; round++) {
      for (let spin = 0; spin < 16; spin++) {
        yield* turn
        if (yield* check) return true
      }
      yield* TestClock.adjust(step)
    }
    return false
  })

const held = <A>(work: (queue: Durable) => Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(open(":memory:"), work)).pipe(
      Effect.provide(TestContext.TestContext)
    )
  )

const handler = (
  run: (unit: Unit) => Effect.Effect<void, Failure, Correlated>
): Handler => ({
  split: (request) => Effect.succeed(request.split(",")),
  run
})

const sent = (payloads: ReadonlyArray<string>, maxAttempts = 3) => ({
  kind: "probe",
  payloads,
  correlation: "c-9",
  maxAttempts
})

const shift = {
  slots: 1,
  leaseMs: 600_000,
  heartbeatMs: 2_000,
  idleMs: 500,
  retryInMs: 1_000,
  graceMs: 1_000,
  ceilings: {}
}

describe("worker identity", () => {
  it("names every instance for itself and keeps that name", () =>
    held((queue) =>
      Effect.gen(function* () {
        const drawn = new Set(
          Array.from({ length: 500 }, () => workerName())
        )
        expect(drawn.size).toBe(500)
        const both = yield* Effect.all(
          [
            start(queue, registry({ probe: handler(() => Effect.void) })),
            start(queue, registry({ probe: handler(() => Effect.void) }))
          ],
          { concurrency: "unbounded" }
        )
        expect(both[0].name).not.toBe(both[1].name)
        expect(both[0].name).toBe(both[0].name)
        yield* both[0].stop
        yield* both[1].stop
      })
    ))
})

describe("job processing", () => {
  it("runs every unit of a job and carries the correlation", () =>
    held((queue) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const worker = yield* start(
          queue,
          registry({
            probe: handler((unit) =>
              Effect.gen(function* () {
                const id = yield* correlation.id
                yield* Ref.update(seen, (was) => [...was, `${unit.payload}:${id}`])
              })
            )
          }),
          shift
        )
        const job = yield* queue.submit(sent(["a", "b", "c"]))
        const done = yield* settle(
          queue.poll(job).pipe(Effect.map((state) => state.state === "done"))
        )
        expect(done).toBe(true)
        const tally = yield* worker.stop
        expect(tally.completed).toBe(3)
        expect([...(yield* Ref.get(seen))].sort()).toEqual([
          "a:c-9",
          "b:c-9",
          "c:c-9"
        ])
      })
    ))

  it("retries a failing unit and gives up at the bound", () =>
    held((queue) =>
      Effect.gen(function* () {
        const worker = yield* start(
          queue,
          registry({
            probe: handler(() =>
              Effect.fail(new Unavailable({ dependency: "engine" }))
            )
          }),
          shift
        )
        const job = yield* queue.submit(sent(["a"], 2))
        const failed = yield* settle(
          queue.poll(job).pipe(Effect.map((state) => state.state === "failed"))
        )
        expect(failed).toBe(true)
        const tally = yield* worker.stop
        expect(tally.failed).toBe(2)
        expect((yield* queue.poll(job)).detail).toBe("engine unavailable")
      })
    ))

  it("holds the ceiling of a kind under load", () =>
    held((queue) =>
      Effect.gen(function* () {
        const live = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const gate = yield* Deferred.make<void>()
        const worker = yield* start(
          queue,
          registry({
            probe: handler(() =>
              Effect.gen(function* () {
                const now = yield* Ref.updateAndGet(live, (was) => was + 1)
                yield* Ref.update(peak, (was) => Math.max(was, now))
                yield* Deferred.await(gate)
                yield* Effect.yieldNow()
                yield* Ref.update(live, (was) => was - 1)
              })
            )
          }),
          {
            ...shift,
            slots: 8,
            ceilings: { probe: { concurrency: 2, rate: undefined } }
          }
        )
        const job = yield* queue.submit(
          sent(Array.from({ length: 24 }, (_, index) => `u${index}`))
        )
        const crowded = yield* settle(
          Ref.get(live).pipe(Effect.map((now) => now >= 2))
        )
        expect(crowded).toBe(true)
        yield* Deferred.succeed(gate, void 0)
        const done = yield* settle(
          queue.poll(job).pipe(Effect.map((state) => state.state === "done"))
        )
        expect(done).toBe(true)
        const tally = yield* worker.stop
        expect(tally.completed).toBe(24)
        expect(yield* Ref.get(peak)).toBe(2)
        expect(yield* Ref.get(live)).toBe(0)
      })
    ))

  it("sees a cancellation inside one heartbeat", () =>
    held((queue) =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const worker = yield* start(
          queue,
          registry({ probe: handler(() => Deferred.await(hold)) }),
          shift
        )
        const job = yield* queue.submit(sent(["a"]))
        const leased = yield* settle(
          queue
            .inspect(job)
            .pipe(Effect.map((units) => units[0]?.state === "leased")),
          500
        )
        expect(leased).toBe(true)
        const asked = yield* Clock.currentTimeMillis
        yield* queue.cancel(job)
        const stopped = yield* settle(
          queue
            .poll(job)
            .pipe(Effect.map((state) => state.state === "cancelled")),
          500
        )
        expect(stopped).toBe(true)
        const units = yield* queue.inspect(job)
        const observed = (units[0]?.updatedAt ?? 0) - asked
        expect(observed).toBeGreaterThan(0)
        expect(observed).toBeLessThanOrEqual(shift.heartbeatMs)
        const tally = yield* worker.stop
        expect(tally.cancelled).toBe(1)
      })
    ))

  it("gives up a unit whose lease it no longer holds", () =>
    held((queue) =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const zombie: Durable = {
          ...queue,
          beat: () => Effect.succeed({ held: false, cancelling: false })
        }
        const worker = yield* start(
          zombie,
          registry({ probe: handler(() => Deferred.await(hold)) }),
          shift
        )
        const job = yield* queue.submit(sent(["a"]))
        const lost = yield* settle(
          worker.report.pipe(Effect.map((tally) => tally.lost === 1)),
          500
        )
        expect(lost).toBe(true)
        expect((yield* queue.inspect(job))[0]?.state).toBe("leased")
        const tally = yield* worker.stop
        expect(tally.handedOver).toBe(0)
      })
    ))

  it("gives the unit up when a heartbeat cannot be sent", () =>
    held((queue) =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const deaf: Durable = {
          ...queue,
          beat: () => Effect.fail(new Unavailable({ dependency: "job queue" }))
        }
        const worker = yield* start(
          deaf,
          registry({ probe: handler(() => Deferred.await(hold)) }),
          shift
        )
        yield* queue.submit(sent(["a"]))
        const lost = yield* settle(
          worker.report.pipe(Effect.map((tally) => tally.lost === 1)),
          500
        )
        expect(lost).toBe(true)
        yield* worker.stop
      })
    ))

  it("records a unit that died and does not die with it", () =>
    held((queue) =>
      Effect.gen(function* () {
        const worker = yield* start(
          queue,
          registry({ probe: handler(() => Effect.die(new Error("boom"))) }),
          shift
        )
        const job = yield* queue.submit(sent(["a"], 1))
        const failed = yield* settle(
          queue.poll(job).pipe(Effect.map((state) => state.state === "failed"))
        )
        expect(failed).toBe(true)
        expect((yield* queue.poll(job)).detail).toBe("unit died")
        const tally = yield* worker.stop
        expect(tally.failed).toBe(1)
      })
    ))

  it("keeps trying when the queue cannot be reached", () =>
    held((queue) =>
      Effect.gen(function* () {
        const broken: Durable = {
          ...queue,
          lease: () => Effect.fail(new Unavailable({ dependency: "job queue" }))
        }
        const worker = yield* start(
          broken,
          registry({ probe: handler(() => Effect.void) }),
          shift
        )
        const tried = yield* settle(
          worker.report.pipe(Effect.map((tally) => tally.faults >= 2)),
          500
        )
        expect(tried).toBe(true)
        const tally = yield* worker.stop
        expect(tally.completed).toBe(0)
      })
    ))
})

describe("shutdown", () => {
  it("drains a unit that finishes inside the grace", () =>
    held((queue) =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const worker = yield* start(
          queue,
          registry({ probe: handler(() => Deferred.await(hold)) }),
          shift
        )
        const job = yield* queue.submit(sent(["a"]))
        const leased = yield* settle(
          queue
            .inspect(job)
            .pipe(Effect.map((units) => units[0]?.state === "leased")),
          500
        )
        expect(leased).toBe(true)
        const stopping = yield* Effect.fork(worker.stop)
        yield* Deferred.succeed(hold, void 0)
        const tally = yield* Fiber.join(stopping)
        expect(tally.completed).toBe(1)
        expect(tally.handedOver).toBe(0)
        expect((yield* queue.poll(job)).state).toBe("done")
      })
    ))

  it("hands work in flight over and loses nothing", () =>
    held((queue) =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const mine = yield* Ref.make<ReadonlyArray<string>>([])
        const first = yield* start(
          queue,
          registry({
            probe: handler((unit) =>
              Effect.zipRight(
                Ref.update(mine, (was) => [...was, unit.unitId]),
                Deferred.await(hold)
              )
            )
          }),
          shift
        )
        const payloads = Array.from({ length: 140 }, (_, index) => `u${index}`)
        const job = yield* queue.submit(sent(payloads))
        const busy = yield* settle(
          Ref.get(mine).pipe(Effect.map((was) => was.length === 1)),
          500
        )
        expect(busy).toBe(true)
        const stopping = yield* Effect.fork(first.stop)
        const drained = yield* settle(
          Fiber.poll(stopping).pipe(Effect.map((over) => over._tag === "Some")),
          500
        )
        expect(drained).toBe(true)
        const handed = yield* Fiber.join(stopping)
        expect(handed.handedOver).toBe(1)
        expect(handed.completed).toBe(0)
        const taken = (yield* Ref.get(mine))[0]
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const second = yield* start(
          queue,
          registry({
            probe: handler((unit) =>
              Ref.update(seen, (was) => [...was, unit.payload])
            )
          }),
          { ...shift, slots: 2 }
        )
        const done = yield* settle(
          queue.poll(job).pipe(Effect.map((state) => state.state === "done")),
          100
        )
        expect(done).toBe(true)
        const tally = yield* second.stop
        expect(tally.completed).toBe(140)
        const state = yield* queue.poll(job)
        expect(state.done).toBe(140)
        expect(state.failed).toBe(0)
        expect(new Set(yield* Ref.get(seen)).size).toBe(140)
        const units = yield* queue.inspect(job)
        const handover = units.find((unit) => unit.unitId === taken)
        expect(handover?.attempts).toBe(1)
        expect(units.every((unit) => unit.state === "done")).toBe(true)
      })
    ))
})

describe("shift defaults", () => {
  it("declares a bounded lease, heartbeat and grace", () => {
    expect(SHIFT.heartbeatMs).toBeLessThan(SHIFT.leaseMs)
    expect(SHIFT.graceMs).toBeGreaterThan(0)
    expect(SHIFT.retryInMs).toBeGreaterThan(0)
  })
})
