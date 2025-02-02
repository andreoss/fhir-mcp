import { describe, expect, it, vi } from "vitest"
import { Effect, Exit, TestClock, TestContext } from "effect"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { open } from "./queue.js"
import type { Durable } from "./queue.js"
import { VIGIL, watch } from "./watchdog.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const turn = Effect.promise(
  () => new Promise<void>((done) => setImmediate(done))
)

const settle = (
  check: Effect.Effect<boolean, Failure>,
  step = 1_000,
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

const sent = (payloads: ReadonlyArray<string>, maxAttempts = 3) => ({
  kind: "probe",
  payloads,
  correlation: "c-3",
  maxAttempts
})

const plan = {
  stalledEveryMs: 5_000,
  defragEveryMs: 5_000,
  purgeEveryMs: 5_000,
  retentionMs: 20_000
}

describe("watchdogs", () => {
  it("declares a schedule for every sweep it runs", () => {
    expect(VIGIL.stalledEveryMs).toBeGreaterThan(0)
    expect(VIGIL.defragEveryMs).toBeGreaterThan(0)
    expect(VIGIL.purgeEveryMs).toBeGreaterThan(0)
    expect(VIGIL.retentionMs).toBeGreaterThan(VIGIL.purgeEveryMs)
  })

  it("reclaims a stalled unit with no operator action", () =>
    held((queue) =>
      Effect.gen(function* () {
        const job = yield* queue.submit(sent(["a"]))
        yield* queue.lease("w-gone", ["probe"], 10_000)
        const dog = yield* watch(queue, plan)
        const back = yield* settle(
          dog.report.pipe(Effect.map((sweeps) => sweeps.reclaimed === 1))
        )
        expect(back).toBe(true)
        expect((yield* queue.inspect(job))[0]?.state).toBe("ready")
        yield* dog.stop
      })
    ))

  it("compacts a finished record without being asked", () =>
    held((queue) =>
      Effect.gen(function* () {
        const job = yield* queue.submit(sent(["a"]))
        const unit = yield* queue.lease("w-a", ["probe"], 10_000)
        yield* queue.complete(unit!)
        const dog = yield* watch(queue, plan)
        const flat = yield* settle(
          dog.report.pipe(Effect.map((sweeps) => sweeps.compacted >= 1))
        )
        expect(flat).toBe(true)
        expect((yield* queue.inspect(job))[0]?.payload).toBe("")
        yield* dog.stop
      })
    ))

  it("purges a finished job once retention has passed", () =>
    held((queue) =>
      Effect.gen(function* () {
        const job = yield* queue.submit(sent(["a"]))
        const unit = yield* queue.lease("w-a", ["probe"], 10_000)
        yield* queue.complete(unit!)
        const dog = yield* watch(queue, plan)
        const gone = yield* settle(
          dog.report.pipe(Effect.map((sweeps) => sweeps.purged === 1)),
          5_000
        )
        expect(gone).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(queue.poll(job)))).toBe(true)
        const sweeps = yield* dog.stop
        expect(sweeps.rounds).toBeGreaterThan(1)
      })
    ))

  it("keeps sweeping after a sweep cannot reach the queue", () =>
    held((queue) =>
      Effect.gen(function* () {
        const broken: Durable = {
          ...queue,
          reclaim: () =>
            Effect.fail(new Unavailable({ dependency: "job queue" }))
        }
        const dog = yield* watch(broken, plan)
        const noticed = yield* settle(
          dog.report.pipe(Effect.map((sweeps) => sweeps.faults >= 2))
        )
        expect(noticed).toBe(true)
        yield* dog.stop
      })
    ))

  it("stops sweeping when it is told to", () =>
    held((queue) =>
      Effect.gen(function* () {
        const dog = yield* watch(queue, plan)
        const ran = yield* settle(
          dog.report.pipe(Effect.map((sweeps) => sweeps.rounds > 0))
        )
        expect(ran).toBe(true)
        const stopped = yield* dog.stop
        yield* TestClock.adjust(60_000)
        expect((yield* dog.report).rounds).toBe(stopped.rounds)
      })
    ))
})
