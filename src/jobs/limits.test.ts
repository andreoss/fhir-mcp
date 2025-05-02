import { describe, expect, it, vi } from "vitest"
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  Ref,
  TestClock,
  TestContext
} from "effect"
import type { Failure } from "../core/outcome.js"
import { CEILING, ceilings, limiter } from "./limits.js"
import type { Limiter } from "./limits.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const turn = Effect.promise(
  () => new Promise<void>((done) => setImmediate(done))
)

const settle = (check: Effect.Effect<boolean>, step = 250, tries = 40) =>
  Effect.gen(function* () {
    for (let round = 0; round < tries; round++) {
      yield* turn
      if (yield* check) return true
      yield* TestClock.adjust(step)
    }
    return false
  })

const run = <A>(work: Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(work.pipe(Effect.provide(TestContext.TestContext)))

const busy = (
  live: Ref.Ref<number>,
  peak: Ref.Ref<number>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Ref.updateAndGet(live, (held) => held + 1)
    yield* Ref.update(peak, (held) => Math.max(held, now))
    yield* Effect.yieldNow()
    yield* Effect.yieldNow()
    yield* Ref.update(live, (held) => held - 1)
  })

const load = (
  gates: Limiter,
  kind: string,
  live: Ref.Ref<number>,
  peak: Ref.Ref<number>,
  units: number
) =>
  Effect.forEach(
    Array.from({ length: units }, (_, index) => index),
    () => gates.gate(kind, busy(live, peak)),
    { concurrency: "unbounded", discard: true }
  )

describe("job limits", () => {
  it("gives a declared kind the default ceiling", () => {
    const built = ceilings(["import", "export"], {
      export: { concurrency: 2, rate: undefined }
    })
    expect(built["import"]).toEqual(CEILING)
    expect(built["export"]?.concurrency).toBe(2)
  })

  it("refuses work of a kind no ceiling declares", () =>
    Effect.runPromiseExit(
      limiter(ceilings(["import"])).pipe(
        Effect.flatMap((gates) => gates.gate("export", Effect.void)),
        Effect.provide(TestContext.TestContext)
      )
    ).then((result) => {
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result) && result.cause._tag === "Fail") {
        expect(result.cause.error._tag).toBe("Rejected")
      }
    }))

  it("never runs more of a kind at once than its ceiling", () =>
    run(
      Effect.gen(function* () {
        const gates = yield* limiter(
          ceilings(["import"], { import: { concurrency: 3, rate: undefined } })
        )
        const live = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        yield* load(gates, "import", live, peak, 40)
        expect(yield* Ref.get(peak)).toBe(3)
        expect(yield* Ref.get(live)).toBe(0)
      })
    ))

  it("holds each kind to its own ceiling", () =>
    run(
      Effect.gen(function* () {
        const gates = yield* limiter(
          ceilings(["import", "export"], {
            import: { concurrency: 1, rate: undefined },
            export: { concurrency: 1, rate: undefined }
          })
        )
        const here = yield* Ref.make(0)
        const there = yield* Ref.make(0)
        const one = yield* Ref.make(0)
        const other = yield* Ref.make(0)
        yield* Effect.all(
          [
            load(gates, "import", here, one, 8),
            load(gates, "export", there, other, 8)
          ],
          { concurrency: "unbounded", discard: true }
        )
        expect(yield* Ref.get(one)).toBe(1)
        expect(yield* Ref.get(other)).toBe(1)
      })
    ))

  it("frees the permit a failing unit held", () =>
    run(
      Effect.gen(function* () {
        const gates = yield* limiter(
          ceilings(["import"], { import: { concurrency: 1, rate: undefined } })
        )
        const broke = yield* Effect.exit(
          gates.gate("import", Effect.fail(new Error("unit died")))
        )
        expect(Exit.isFailure(broke)).toBe(true)
        expect(yield* gates.gate("import", Effect.succeed(7))).toBe(7)
      })
    ))

  it("admits only the rate a kind allows in one window", () =>
    run(
      Effect.gen(function* () {
        const gates = yield* limiter(
          ceilings(["import"], {
            import: { concurrency: 4, rate: { count: 2, windowMs: 1000 } }
          })
        )
        const seen = yield* Ref.make<ReadonlyArray<number>>([])
        const mark = Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* Ref.update(seen, (held) => [...held, at])
        })
        const fiber = yield* Effect.fork(
          Effect.forEach(
            [0, 1, 2, 3],
            () => gates.gate("import", mark),
            { concurrency: "unbounded", discard: true }
          )
        )
        const done = yield* settle(
          Ref.get(seen).pipe(Effect.map((held) => held.length === 4))
        )
        expect(done).toBe(true)
        yield* Fiber.join(fiber)
        const at = [...(yield* Ref.get(seen))].sort((a, b) => a - b)
        expect(at).toEqual([0, 0, 1000, 1000])
      })
    ))
})
