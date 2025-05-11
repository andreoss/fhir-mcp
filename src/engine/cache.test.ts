import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { Scoped } from "../compartment/search.js"
import { cache } from "./cache.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const plan = (sql: string): Scoped => ({
  count: { sql, values: [] },
  page: { sql, values: [] },
  include: undefined,
  revinclude: undefined
})

describe("a prepared plan is kept and reused", () => {
  it("misses an empty cache and hits a filled one", async () => {
    const held = await run(cache())
    expect(await run(held.take("a"))).toBeUndefined()
    const one = plan("select 1")
    await run(held.keep("a", one))
    const found = await run(held.take("a"))
    expect(found?.plan).toBe(one)
    expect(found?.key).toBe("a")
    const state = await run(held.state)
    expect(state.hits).toBe(1)
    expect(state.misses).toBe(1)
    expect(state.keys).toEqual(["a"])
  })

  it("keeps one entry per key", async () => {
    const held = await run(cache())
    await run(held.keep("a", plan("select 1")))
    await run(held.keep("b", plan("select 2")))
    expect((await run(held.state)).keys).toEqual(["a", "b"])
    expect((await run(held.take("b")))?.plan.count.sql).toBe("select 2")
  })

  it("replaces the plan held under one key", async () => {
    const held = await run(cache())
    await run(held.keep("a", plan("select 1")))
    await run(held.keep("a", plan("select 2")))
    expect((await run(held.state)).keys).toEqual(["a"])
    expect((await run(held.take("a")))?.plan.count.sql).toBe("select 2")
  })

  it("drops the oldest entry once it is full", async () => {
    const held = await run(cache(2))
    await run(held.keep("a", plan("select 1")))
    await run(held.keep("b", plan("select 2")))
    await run(held.keep("c", plan("select 3")))
    expect((await run(held.state)).keys).toEqual(["b", "c"])
  })
})

describe("a regression disables the cache", () => {
  it("empties it and stops answering from it", async () => {
    const held = await run(cache())
    await run(held.keep("a", plan("select 1")))
    await run(held.demote("a cached plan did not match its key"))
    const state = await run(held.state)
    expect(state.enabled).toBe(false)
    expect(state.keys).toEqual([])
    expect(state.reason).toContain("did not match")
    expect(await run(held.take("a"))).toBeUndefined()
  })

  it("keeps nothing once disabled", async () => {
    const held = await run(cache())
    await run(held.demote("regressed"))
    await run(held.keep("a", plan("select 1")))
    expect((await run(held.state)).keys).toEqual([])
  })
})
