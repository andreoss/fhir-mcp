import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { grant } from "../auth/scope.js"
import { manager } from "./definition.js"
import { limitsOf } from "./grant.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const read = { action: "read" as const, type: "Observation" }

describe("the limits a grant imposes", () => {
  it("binds a patient scope to the compartment it names", async () => {
    const held = await run(manager())
    const found = await run(
      limitsOf(held, grant(["patient:p1/Observation.read"]), read)
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.ids).toEqual(["p1"])
    expect(found[0]?.definition.code).toBe("patient")
  })

  it("takes every compartment the grant names", async () => {
    const held = await run(manager())
    const found = await run(
      limitsOf(
        held,
        grant(["patient:p1/Observation.read", "patient:p2/*.read"]),
        read
      )
    )
    expect(found[0]?.ids).toEqual(["p1", "p2"])
  })

  it("imposes nothing when a scope names no compartment", async () => {
    const held = await run(manager())
    expect(await run(limitsOf(held, grant(["user/Observation.read"]), read)))
      .toEqual([])
  })

  it("refuses an action no scope covers", async () => {
    const held = await run(manager())
    expect(
      tag(await exit(limitsOf(held, grant(["patient:p1/Observation.write"]), read)))
    ).toBe("Forbidden")
  })

  it("refuses a type no scope covers", async () => {
    const held = await run(manager())
    expect(
      tag(
        await exit(
          limitsOf(held, grant(["patient:p1/Condition.read"]), read)
        )
      )
    ).toBe("Forbidden")
  })

  it("refuses a compartment carried by a scope that is not a patient scope", async () => {
    const held = await run(manager())
    expect(
      tag(await exit(limitsOf(held, grant(["user:u1/Observation.read"]), read)))
    ).toBe("Rejected")
  })

  it("refuses when the compartment definition is gone", async () => {
    const held = await run(manager())
    await run(held.drop("patient"))
    expect(
      tag(await exit(limitsOf(held, grant(["patient:p1/Observation.read"]), read)))
    ).toBe("Rejected")
  })

  it("covers an action a wildcard scope names", async () => {
    const held = await run(manager())
    const found = await run(
      limitsOf(held, grant(["patient:p1/Observation.*"]), read)
    )
    expect(found[0]?.ids).toEqual(["p1"])
  })
})
