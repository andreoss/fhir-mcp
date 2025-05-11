import { describe, expect, it, vi } from "vitest"
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  TestClock,
  TestContext
} from "effect"
import {
  Conflict,
  Forbidden,
  Gone,
  NotFound,
  Rejected,
  Unavailable
} from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { PLAN, fault, retrier, translate, waitFor } from "./retry.js"
import type { Plan } from "./retry.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const turn = Effect.promise(
  () => new Promise<void>((done) => setImmediate(done))
)

const run = <A, E>(work: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(work.pipe(Effect.provide(TestContext.TestContext)))

const settle = <A, E>(
  fiber: Fiber.RuntimeFiber<A, E>,
  step = 100,
  tries = 80
) =>
  Effect.gen(function* () {
    for (let round = 0; round < tries; round++) {
      for (let spin = 0; spin < 8; spin++) {
        yield* turn
        const done = yield* Fiber.poll(fiber)
        if (Option.isSome(done)) return done.value
      }
      yield* TestClock.adjust(step)
    }
    return undefined
  })

const failed = <A, E>(result: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return result.cause.error
  }
  throw new Error("expected a failure")
}

const plan: Plan = { attempts: 4, baseMs: 100, capMs: 400, parallel: 2 }

const flaky = (calls: Ref.Ref<number>, until: number) =>
  Effect.flatMap(
    Ref.updateAndGet(calls, (n) => n + 1),
    (n): Effect.Effect<number, Failure> =>
      n < until
        ? Effect.fail(new Unavailable({ dependency: "store" }))
        : Effect.succeed(n)
  )

const permanent: ReadonlyArray<readonly [string, Failure]> = [
  ["rejected", new Rejected({ reason: "bad body" })],
  ["conflict", new Conflict({ reason: "version already written" })],
  ["not found", new NotFound({ type: "Patient", id: "p1" })],
  ["gone", new Gone({ type: "Patient", id: "p1" })],
  ["forbidden", new Forbidden({ action: "write" })]
]

describe("retries and classification", () => {
  it("classifies every declared failure explicitly", () => {
    expect(fault(new Unavailable({ dependency: "store" }))).toBe("transient")
    for (const [, failure] of permanent) {
      expect(fault(failure)).toBe("permanent")
    }
  })

  it("translates driver text into a typed failure", () => {
    expect(translate(new Error("Constraint Error: duplicate")).
      _tag).toBe("Conflict")
    expect(fault(translate(new Error("Constraint Error: dup")))).toBe(
      "permanent"
    )
    expect(translate(new Error("Binder Error: no column")).
      _tag).toBe("Rejected")
    expect(translate(new Error("Catalog Error: no table")).
      _tag).toBe("Rejected")
    expect(translate(new Error("IO Error: disk")). _tag).toBe("Unavailable")
    expect(fault(translate(new Error("connection was closed")))).toBe(
      "transient"
    )
  })

  it("treats an unclassified driver fault as permanent", () => {
    const failure = translate(new Error("something nobody wrote a rule for"))
    expect(failure._tag).toBe("Rejected")
    expect(fault(failure)).toBe("permanent")
  })

  it("grows the wait and caps it", () => {
    expect(waitFor(plan, 1)).toBe(100)
    expect(waitFor(plan, 2)).toBe(200)
    expect(waitFor(plan, 3)).toBe(400)
    expect(waitFor(plan, 9)).toBe(400)
    expect(PLAN.attempts).toBeGreaterThan(1)
    expect(PLAN.parallel).toBeGreaterThan(0)
  })

  it("retries a transient fault until it clears", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const held = yield* retrier(plan)
        const fiber = yield* Effect.fork(held.run(flaky(calls, 3)))
        const done = yield* settle(fiber)
        expect(done === undefined ? undefined : Exit.isSuccess(done)).toBe(true)
        expect(yield* Ref.get(calls)).toBe(3)
      })
    ))

  it.each(permanent)("does not retry a %s fault", (_name, failure) =>
    run(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const held = yield* retrier(plan)
        const before = yield* Clock.currentTimeMillis
        const outcome = yield* Effect.exit(
          held.run(
            Effect.zipRight(
              Ref.update(calls, (n) => n + 1),
              Effect.fail(failure)
            )
          )
        )
        expect(failed(outcome)).toBe(failure)
        expect(yield* Ref.get(calls)).toBe(1)
        expect(yield* Clock.currentTimeMillis).toBe(before)
      })
    ))

  it("gives up once the declared attempts are spent", () =>
    run(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const held = yield* retrier(plan)
        const fiber = yield* Effect.fork(held.run(flaky(calls, 99)))
        const done = yield* settle(fiber)
        expect(done === undefined ? "" : failed(done)._tag).toBe("Unavailable")
        expect(yield* Ref.get(calls)).toBe(plan.attempts)
      })
    ))

  it("throttles retries so a fault storm does not multiply load", () =>
    run(
      Effect.gen(function* () {
        const held = yield* retrier({ ...plan, parallel: 1 })
        const callers = yield* Effect.forEach([1, 2, 3, 4], () => Ref.make(0))
        const fiber = yield* Effect.fork(
          Effect.forEach(
            callers,
            (calls) => held.run(Effect.zipRight(Effect.yieldNow(),
              flaky(calls, 3))),
            { concurrency: "unbounded" }
          )
        )
        const done = yield* settle(fiber)
        expect(done === undefined ? undefined : Exit.isSuccess(done)).toBe(true)
        expect(yield* held.peak).toBe(1)
      })
    ))

  it("lets attempts run side by side up to the declared width", () =>
    run(
      Effect.gen(function* () {
        const held = yield* retrier({ ...plan, parallel: 2 })
        const callers = yield* Effect.forEach([1, 2, 3, 4], () => Ref.make(0))
        const fiber = yield* Effect.fork(
          Effect.forEach(
            callers,
            (calls) => held.run(Effect.zipRight(Effect.yieldNow(),
              flaky(calls, 2))),
            { concurrency: "unbounded" }
          )
        )
        yield* settle(fiber)
        expect(yield* held.peak).toBeLessThanOrEqual(2)
        expect(yield* held.peak).toBeGreaterThan(0)
      })
    ))
})
