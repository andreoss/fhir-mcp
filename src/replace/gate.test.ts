import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Answer, Pair, Request, Run } from "./shadow.js"
import { report } from "./diff.js"
import type { Report } from "./diff.js"
import { AGREED, check, declared, gated } from "./gate.js"
import type { Policy } from "./gate.js"

const asking: Request = { kind: "read", type: "Patient", id: "p1" }

const other: Request = { kind: "read", type: "Patient", id: "p2" }

const one = (family: string): Answer => ({
  of: "resource",
  body: { resourceType: "Patient", id: "p1", name: [{ family }] }
})

const gone: Answer = { of: "failure", tag: "NotFound", detail: "Patient/p1 not found" }

const running = (found: ReadonlyArray<Pair>): Run => ({
  left: "incumbent",
  right: "successor",
  pair: found
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const tag = async <A, E>(effect: Effect.Effect<A, E>): Promise<string> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const clean: Report = report(running([{ request: asking, left: one("a"), right: one("a") }]))

const drifted: Report = report(
  running([{ request: asking, left: one("a"), right: one("b") }])
)

const missing: Report = report(
  running([
    { request: asking, left: one("a"), right: gone },
    { request: other, left: one("a"), right: gone }
  ])
)

describe("acceptance policy", () => {
  it("holds every divergence class either forbidden or tolerated", async () => {
    expect(await run(declared(AGREED))).toEqual(AGREED)
    expect(AGREED.empty).toContain("only-left")
    expect(AGREED.tolerated).toContain("field")
  })

  it("refuses a policy that leaves a class unclassified", async () => {
    const partial: Policy = { ...AGREED, empty: ["only-left", "only-right"], tolerated: [] }
    expect(await tag(declared(partial))).toBe("Rejected")
  })

  it("refuses a policy that classifies a class twice", async () => {
    const doubled: Policy = { ...AGREED, tolerated: [...AGREED.tolerated, "count"] }
    expect(await tag(declared(doubled))).toBe("Rejected")
  })

  it("refuses a policy with no budget and no agreement", async () => {
    expect(await tag(declared({ ...AGREED, budget: -1 }))).toBe("Rejected")
    expect(await tag(declared({ ...AGREED, agreed: "" }))).toBe("Rejected")
  })
})

describe("acceptance gate", () => {
  it("passes a run with no divergence at all", async () => {
    const verdict = await run(check(AGREED, clean))
    expect(verdict.pass).toBe(true)
    expect(verdict.breach).toEqual([])
    expect(verdict.reason).toEqual([])
  })

  it("passes a run that carries only tolerated classes", async () => {
    const verdict = await run(check(AGREED, drifted))
    expect(verdict.pass).toBe(true)
    expect(verdict.breach).toEqual([])
    expect(verdict.allowed).toEqual([{ kind: "field", count: 1, first: asking }])
  })

  it("fails a run that carries a forbidden class, naming the request", async () => {
    const verdict = await run(check(AGREED, missing))
    expect(verdict.pass).toBe(false)
    expect(verdict.breach).toEqual([{ kind: "only-left", count: 2, first: asking }])
    expect(verdict.reason).toEqual(["only-left is not empty: 2"])
    expect(verdict.policy).toEqual(AGREED)
  })

  it("fails a run that spends more than the tolerated budget", async () => {
    const tight: Policy = { ...AGREED, budget: 0 }
    const verdict = await run(check(tight, drifted))
    expect(verdict.pass).toBe(false)
    expect(verdict.breach).toEqual([])
    expect(verdict.reason).toEqual(["tolerated divergence 1 is over the budget of 0"])
  })

  it("refuses to check a run against a policy that was never settled", async () => {
    expect(await tag(check({ ...AGREED, tolerated: [] }, clean))).toBe("Rejected")
  })

  it("settles the policy before the run rather than after", async () => {
    let ran = 0
    const work = Effect.sync(() => {
      ran = ran + 1
      return clean
    })
    expect(await tag(gated({ ...AGREED, tolerated: [] }, work))).toBe("Rejected")
    expect(ran).toBe(0)
    const verdict = await run(gated(AGREED, work))
    expect(verdict.pass).toBe(true)
    expect(ran).toBe(1)
  })
})
