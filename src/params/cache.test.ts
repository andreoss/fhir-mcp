import { describe, expect, it } from "vitest"
import { Effect, Fiber, Option, TestClock, TestContext } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { engineOn } from "../store/store.js"
import { seed } from "./model.js"
import type { Definition, Snapshot } from "./model.js"
import { registryOn } from "./registry.js"
import type { Registry } from "./registry.js"
import { cacheOn } from "./cache.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const NICK: Definition = {
  type: "Patient",
  name: "nickname",
  valueType: "token",
  path: ["name", "text"],
  targets: [],
  components: []
}

interface Pair {
  readonly one: Registry
  readonly two: Registry
}

const pair = async (): Promise<Pair> => {
  const instance = await DuckDBInstance.create(":memory:")
  const left = await instance.connect()
  const right = await instance.connect()
  await run(engineOn(left))
  const one = await run(registryOn(left))
  const two = await run(registryOn(right))
  return { one, two }
}

const tick = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0))
)

const settle = (
  read: Effect.Effect<Snapshot>,
  ok: (held: Snapshot) => boolean
): Effect.Effect<Snapshot> =>
  Effect.gen(function* () {
    for (let round = 0; round < 200; round++) {
      const held = yield* read
      if (ok(held)) return held
      yield* tick
    }
    return yield* read
  })

describe("registry cache", () => {
  it("is loaded before it is handed out", async () => {
    const db = await pair()
    await run(db.one.install)
    const cache = await run(cacheOn(db.two))
    const held = await run(cache.cached)
    expect(held.entries.size).toBe(seed().length)
    expect(await run(cache.loads)).toBe(1)
  })

  it("serves the cached snapshot while the shared epoch holds", async () => {
    const db = await pair()
    const cache = await run(cacheOn(db.two))
    await run(cache.current)
    await run(cache.current)
    expect(await run(cache.loads)).toBe(1)
  })

  it("picks up a change another instance made", async () => {
    const db = await pair()
    const cache = await run(cacheOn(db.two))
    await run(db.one.create(NICK))
    const held = await run(cache.current)
    expect(held.entries.has("Patient.nickname")).toBe(true)
    expect(await run(cache.loads)).toBe(2)
  })

  it("converges two instances on the same snapshot as time passes", async () => {
    const db = await pair()
    const found = await run(
      Effect.gen(function* () {
        const left = yield* cacheOn(db.one)
        const right = yield* cacheOn(db.two)
        const poller = yield* Effect.fork(right.poll("10 seconds"))
        yield* db.one.create(NICK)
        const stale = yield* right.cached
        const ahead = yield* left.current
        yield* TestClock.adjust("10 seconds")
        const fresh = yield* settle(right.cached, (held) => held.epoch === ahead.epoch)
        yield* Fiber.interrupt(poller)
        return { stale, ahead, fresh }
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(found.stale.entries.has("Patient.nickname")).toBe(false)
    expect(found.ahead.entries.has("Patient.nickname")).toBe(true)
    expect(found.fresh.epoch).toBe(found.ahead.epoch)
    expect([...found.fresh.entries.keys()]).toEqual([...found.ahead.entries.keys()])
  })

  it("reloads only on the tick that meets a new epoch", async () => {
    const db = await pair()
    const found = await run(
      Effect.gen(function* () {
        const cache = yield* cacheOn(db.two)
        const poller = yield* Effect.fork(cache.poll("1 second"))
        yield* TestClock.adjust("5 seconds")
        yield* db.one.create(NICK)
        yield* TestClock.adjust("1 second")
        const fresh = yield* settle(cache.cached, (held) =>
          held.entries.has("Patient.nickname")
        )
        yield* Fiber.interrupt(poller)
        return { loads: yield* cache.loads, fresh }
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(found.fresh.entries.has("Patient.nickname")).toBe(true)
    expect(found.loads).toBe(2)
  })

  it("never starts an instance on a half written registry", async () => {
    const db = await pair()
    await run(db.one.install)
    const before = await run(db.two.epoch)
    const base = seed().length
    const seen = await run(
      Effect.gen(function* () {
        const writer = yield* Effect.fork(db.one.create(NICK))
        const out: Array<{ readonly live: boolean; readonly held: Snapshot }> = []
        for (let round = 0; round < 30; round++) {
          const live = Option.isNone(yield* Fiber.poll(writer))
          const fresh = yield* cacheOn(db.two)
          out.push({ live, held: yield* fresh.cached })
          yield* Effect.yieldNow()
        }
        yield* Fiber.join(writer)
        return out
      })
    )
    expect(seen.some((one) => one.live)).toBe(true)
    expect(seen.some((one) => one.held.entries.size === base + 1)).toBe(true)
    for (const one of seen) {
      const has = one.held.entries.has("Patient.nickname")
      expect(has).toBe(one.held.epoch > before)
      expect(one.held.entries.size).toBe(has ? base + 1 : base)
    }
  })

  it("reloads once when two fibers meet a new epoch together", async () => {
    const db = await pair()
    const cache = await run(cacheOn(db.two))
    await run(db.one.create(NICK))
    await run(Effect.all([cache.current, cache.current], { concurrency: "unbounded" }))
    expect(await run(cache.loads)).toBe(2)
  })
})

describe("forced refresh", () => {
  it("reloads even when the shared epoch has not moved", async () => {
    const db = await pair()
    const cache = await run(cacheOn(db.two))
    const held = await run(cache.refresh)
    expect(held.epoch).toBe(await run(db.two.epoch))
    expect(await run(cache.loads)).toBe(2)
  })
})
