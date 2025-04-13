import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Denial } from "./failure.js"
import { status } from "./failure.js"
import { challenge, prove, verifier } from "./pkce.js"

const run = (v: string, c: string, method: string) => Effect.runSyncExit(prove(v, c, method))

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

describe("proof key", () => {
  it("makes a verifier of the length the grant demands", () => {
    const made = verifier()
    expect(made).toHaveLength(43)
    expect(made).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(verifier()).not.toBe(made)
  })

  it("derives a challenge that is not the verifier", () => {
    const v = verifier()
    expect(challenge(v)).toHaveLength(43)
    expect(challenge(v)).not.toBe(v)
    expect(challenge(v)).toBe(challenge(v))
  })

  it("accepts the verifier the challenge was derived from", () => {
    const v = verifier()
    expect(Exit.isSuccess(run(v, challenge(v), "S256"))).toBe(true)
  })

  it("refuses the plain method", () => {
    const v = verifier()
    expect(status(denial(run(v, v, "plain")))).toBe(400)
  })

  it("refuses a method it was not given", () => {
    const v = verifier()
    expect(status(denial(run(v, challenge(v), "")))).toBe(400)
  })

  it("refuses another verifier", () => {
    expect(status(denial(run(verifier(), challenge(verifier()), "S256")))).toBe(400)
  })

  it("refuses a verifier that is too short or badly formed", () => {
    expect(status(denial(run("short", challenge("short"), "S256")))).toBe(400)
    const long = "a".repeat(129)
    expect(status(denial(run(long, challenge(long), "S256")))).toBe(400)
    const bad = `${"a".repeat(42)}/`
    expect(status(denial(run(bad, challenge(bad), "S256")))).toBe(400)
  })

  it("refuses a challenge of the wrong shape", () => {
    const v = verifier()
    expect(status(denial(run(v, "tiny", "S256")))).toBe(400)
  })
})
