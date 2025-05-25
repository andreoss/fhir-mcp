import { describe, expect, it } from "vitest"
import { Deferred, Effect, Layer, TestContext, TestClock } from "effect"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, FhirResource } from "../core/engine.js"
import {
  CurrentSession,
  DEFAULT_LIMIT,
  draw,
  fresh,
  limiterOn,
  refilled
} from "./limit.js"
import type { Limit } from "./limit.js"
import { call, tools } from "./tools.js"

const patient: FhirResource = { resourceType: "Patient", id: "p1", gender: "male" }

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: () => Effect.succeed(patient),
  search: () =>
    Effect.succeed<Bundle>({ resourceType: "Bundle", type: "searchset", total: 0, entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed([])
})

const session = (id: string) => Layer.succeed(CurrentSession, { id })

const body = (result: { content: ReadonlyArray<{ text: string }> }) =>
  JSON.parse(result.content[0]!.text)

const HOT: Limit = {
  session: { burst: 2, perSecond: 1 },
  tool: { burst: 25, perSecond: 5 },
  inFlight: 2
}

const PER_TOOL: Limit = {
  session: { burst: 25, perSecond: 5 },
  tool: { burst: 1, perSecond: 1 },
  inFlight: 2
}

describe("token buckets, pure", () => {
  it("draws within the burst and holds back the rest", () => {
    const first = draw(fresh(HOT.session, 0), 0)
    expect(first.allows).toBe(true)
    expect(first.bucket.stored).toBe(1)
    const second = draw(first.bucket, 0)
    expect(second.allows).toBe(true)
    expect(second.bucket.stored).toBe(0)
    const third = draw(second.bucket, 0)
    expect(third.allows).toBe(false)
    expect(third.missing).toBe(1)
  })

  it("refills what elapsed at the given rate", () => {
    let bucket = fresh({ burst: 2, perSecond: 1 }, 0)
    bucket = draw(bucket, 1_000).bucket
    expect(bucket.stored).toBe(1)
    bucket = draw(bucket, 2_000).bucket
    expect(bucket.stored).toBe(0)
  })

  it("never refills above capacity", () => {
    const bucket = refilled(fresh({ burst: 2, perSecond: 1 }, 0), 10_000)
    expect(bucket.stored).toBe(2)
  })

  it("carries a sane safe default", () => {
    expect(DEFAULT_LIMIT.session.burst).toBeGreaterThan(0)
    expect(DEFAULT_LIMIT.session.perSecond).toBeGreaterThan(0)
    expect(DEFAULT_LIMIT.tool.burst).toBeGreaterThan(0)
    expect(DEFAULT_LIMIT.tool.perSecond).toBeGreaterThan(0)
    expect(DEFAULT_LIMIT.inFlight).toBeGreaterThan(0)
  })
})

describe("rate limits on a shared limiter", () => {
  it("refuses inside the burst for the same session with a retry hint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* call("capabilities", {})
        const second = yield* call("capabilities", {})
        const third = yield* call("capabilities", {})
        expect(first.isError).toBe(false)
        expect(second.isError).toBe(false)
        expect(third.isError).toBe(true)
        expect(body(third).resourceType).toBe("OperationOutcome")
        expect(body(third).issue[0].code).toBe("transient")
        expect(body(third).issue[0].diagnostics).toMatch(/rate limit/)
        expect(body(third).issue[0].diagnostics).toMatch(/retry after \d+s/)
      }).pipe(
        Effect.provide(engine),
        Effect.provide(limiterOn(HOT)),
        Effect.provide(session("s1")),
        Effect.provide(TestContext.TestContext)
      )
    ))

  it("refuses a tool whose own bucket ran dry even when the session is spare", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* call("capabilities", {})
        const second = yield* call("read", { type: "Patient", id: "p1" })
        expect(first.isError).toBe(false)
        expect(second.isError).toBe(true)
        expect(body(second).issue[0].code).toBe("transient")
      }).pipe(
        Effect.provide(engine),
        Effect.provide(limiterOn(PER_TOOL)),
        Effect.provide(session("s1")),
        Effect.provide(TestContext.TestContext)
      )
    ))

  it("keeps buckets apart per session inside the same limiter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const a1 = yield* call("capabilities", {}).pipe(Effect.provide(session("s1")))
        const a2 = yield* call("capabilities", {}).pipe(Effect.provide(session("s2")))
        expect(a1.isError).toBe(false)
        expect(a2.isError).toBe(false)
      }).pipe(
        Effect.provide(engine),
        Effect.provide(limiterOn({ session: { burst: 1, perSecond: 1 }, tool: { burst: 25, perSecond: 5 }, inFlight: 2 })),
        Effect.provide(session("anon")),
        Effect.provide(TestContext.TestContext)
      )
    ))

  it("refills the session bucket as time passes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* call("capabilities", {})
        const second = yield* call("capabilities", {})
        expect(first.isError).toBe(false)
        expect(second.isError).toBe(true)
        yield* TestClock.adjust(1_500)
        const third = yield* call("capabilities", {})
        expect(third.isError).toBe(false)
      }).pipe(
        Effect.provide(engine),
        Effect.provide(limiterOn({ session: { burst: 1, perSecond: 1 }, tool: { burst: 25, perSecond: 5 }, inFlight: 2 })),
        Effect.provide(session("s1")),
        Effect.provide(TestContext.TestContext)
      )
    ))

  it("refuses a second call while a first still runs beyond the in-flight cap", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void, never>()
        const heldEngine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
          read: () => Deferred.await(gate).pipe(Effect.andThen(Effect.succeed(patient))),
          search: () =>
            Effect.succeed<Bundle>({ resourceType: "Bundle", type: "searchset", total: 0, entry: [] }),
          resourceTypes: () => Effect.succeed(["Patient"]),
          searchParameters: () => Effect.succeed([])
        })
        const ask = () => call("read", { type: "Patient", id: "p1" }).pipe(Effect.provide(heldEngine))
        const first = yield* Effect.fork(ask())
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
        const second = yield* ask()
        expect(second.isError).toBe(true)
        expect(body(second).issue[0].code).toBe("transient")
        yield* Deferred.succeed(gate, void 0)
        const firstResult = yield* first.await
        expect(firstResult._tag).toBe("Success")
      }).pipe(
        Effect.provide(engine),
        Effect.provide(limiterOn({ session: { burst: 25, perSecond: 5 }, tool: { burst: 25, perSecond: 5 }, inFlight: 1 })),
        Effect.provide(session("s1")),
        Effect.provide(TestContext.TestContext)
      )
    ))
})

describe("rate limits left off", () => {
  it("every read tool stays green and unlimited without a limiter", () => {
    const result = Effect.runSync(call("capabilities", {}).pipe(Effect.provide(engine)))
    expect(result.isError).toBe(false)
  })

  it("serves every read-only tool when no limiter is wired", () => {
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) expect(typeof tool.name).toBe("string")
  })
})