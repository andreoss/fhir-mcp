import { describe, expect, it } from "vitest"
import { Effect, Fiber } from "effect"
import { NONE, accept, edge, handoff, id, known, mint, resume } from "./correlation.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("correlation", () => {
  it("mints an id at the edge", async () => {
    const seen = await run(edge(id))
    expect(seen).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("mints a different id for every edge", async () => {
    const a = await run(edge(id))
    const b = await run(edge(id))
    expect(a).not.toBe(b)
  })

  it("keeps an id a caller supplies when its shape is bounded", async () => {
    expect(await run(edge(id, "req-01"))).toBe("req-01")
  })

  it("refuses a smuggled id or search value and mints instead", async () => {
    const seen = await run(edge(id, "Patient/p1?family=Simpson"))
    expect(seen).not.toContain("Simpson")
    expect(seen).not.toContain("p1")
    expect(seen).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("refuses an id longer than the bound", async () => {
    const long = "a".repeat(65)
    expect(await run(edge(id, long))).not.toBe(long)
  })

  it("accepts nothing as nothing to keep", () => {
    expect(accept(undefined)).not.toBe(mint())
    expect(accept("abc")).toBe("abc")
  })

  it("survives an asynchronous boundary", async () => {
    const flow = Effect.gen(function* () {
      const before = yield* id
      yield* Effect.promise(() => new Promise((done) => setTimeout(done, 5)))
      yield* Effect.sleep("3 millis")
      const after = yield* id
      return { before, after }
    })
    const seen = await run(edge(flow, "req-async"))
    expect(seen.after).toBe(seen.before)
    expect(seen.after).toBe("req-async")
  })

  it("survives a forked fiber", async () => {
    const flow = Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.sleep("2 millis").pipe(Effect.zipRight(id)))
      return yield* Fiber.join(fiber)
    })
    expect(await run(edge(flow, "req-fork"))).toBe("req-fork")
  })

  it("never lets one flow see the id of another", async () => {
    const flow = (given: string) =>
      edge(
        Effect.gen(function* () {
          const first = yield* id
          yield* Effect.sleep("5 millis")
          const second = yield* id
          return [first, second] as const
        }),
        given
      )
    const [a, b] = await run(
      Effect.all([flow("req-a"), flow("req-b")], { concurrency: "unbounded" })
    )
    expect(a).toEqual(["req-a", "req-a"])
    expect(b).toEqual(["req-b", "req-b"])
  })

  it("carries the id across a job boundary", async () => {
    const token = await run(edge(handoff, "req-job"))
    expect(token.correlation).toBe("req-job")
    const worked = await run(resume(token, id))
    expect(worked).toBe("req-job")
  })

  it("refuses a handoff carrying a smuggled value", async () => {
    const worked = await run(resume({ correlation: "Simpson, Bart" }, id))
    expect(worked).not.toContain("Simpson")
  })

  it("reports no correlation outside a request", async () => {
    expect(await run(known)).toBe(NONE)
    expect(await run(edge(known, "req-known"))).toBe("req-known")
  })
})
