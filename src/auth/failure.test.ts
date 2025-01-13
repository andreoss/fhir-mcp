import { describe, expect, it } from "vitest"
import { Forbidden, Rejected, Unavailable } from "../core/outcome.js"
import { Unauthorized, outcome, status } from "./failure.js"

describe("refusal status", () => {
  it("answers 401 when the token is not accepted", () => {
    expect(status(new Unauthorized({ reason: "token expired" }))).toBe(401)
  })

  it("answers 403 when the grant does not cover the action", () => {
    expect(status(new Forbidden({ action: "write Patient" }))).toBe(403)
  })

  it("answers 400 when the request is malformed", () => {
    expect(status(new Rejected({ reason: "token malformed" }))).toBe(400)
  })

  it("leaves the shared failures as the core states them", () => {
    expect(status(new Unavailable({ dependency: "issuer metadata" }))).toBe(503)
  })
})

describe("refusal outcome", () => {
  it("states the reason and stays a security issue", () => {
    const stated = outcome(new Unauthorized({ reason: "signature not accepted" }))
    expect(stated.resourceType).toBe("OperationOutcome")
    expect(stated.issue[0]?.diagnostics).toBe("signature not accepted")
    expect(stated.issue[0]?.code).toBe("forbidden")
  })

  it("renders the shared failures as the core does", () => {
    expect(outcome(new Rejected({ reason: "bad" })).issue[0]?.code).toBe("invalid")
  })
})
