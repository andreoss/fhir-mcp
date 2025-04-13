import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { bearer } from "./bearer.js"
import type { Presented } from "./bearer.js"
import { status } from "./failure.js"
import type { Denial } from "./failure.js"

const run = (presented: Presented) => Effect.runSyncExit(bearer(presented))

const token = <A>(exit: Exit.Exit<A, Denial>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected a token")
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

describe("bearer token", () => {
  it("takes the token from the authorization header", () => {
    expect(token(run({ headers: { authorization: "Bearer abc.def.ghi" } }))).toBe("abc.def.ghi")
  })

  it("does not care how the header name or the scheme is cased", () => {
    expect(token(run({ headers: { Authorization: "bearer abc" } }))).toBe("abc")
  })

  it("refuses a token carried in a query string", () => {
    const refusal = denial(run({ headers: {}, query: { access_token: "abc" } }))
    expect(status(refusal)).toBe(400)
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a query string token even when the header carries one too", () => {
    const refusal = denial(run({
      headers: { authorization: "Bearer abc" },
      query: { access_token: "abc" }
    }))
    expect(status(refusal)).toBe(400)
  })

  it("answers 401 when no authorization was presented", () => {
    expect(status(denial(run({ headers: {} })))).toBe(401)
    expect(status(denial(run({ headers: { authorization: "  " } })))).toBe(401)
  })

  it("answers 400 for another scheme", () => {
    expect(status(denial(run({ headers: { authorization: "Basic dXNlcjpwdw==" } })))).toBe(400)
  })

  it("answers 400 for an empty or split token", () => {
    expect(status(denial(run({ headers: { authorization: "Bearer" } })))).toBe(400)
    expect(status(denial(run({ headers: { authorization: "Bearer " } })))).toBe(400)
    expect(status(denial(run({ headers: { authorization: "Bearer a b" } })))).toBe(400)
  })

  it("ignores a query string that carries no token", () => {
    expect(token(run({ headers: { authorization: "Bearer abc" }, query: { page: "2" } }))).toBe("abc")
  })
})
