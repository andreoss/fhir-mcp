import { describe, expect, it } from "vitest"
import { Conflict, Forbidden, Gone, NotFound, Rejected, Unavailable, statusOf, toOutcome } from "./outcome.js"

describe("operation outcome", () => {
  it("renders a not-found as a 404 outcome naming neither store nor stack", () => {
    const error = new NotFound({ type: "Patient", id: "p1" })
    expect(statusOf(error)).toBe(404)
    const outcome = toOutcome(error)
    expect(outcome.resourceType).toBe("OperationOutcome")
    expect(outcome.issue[0]?.severity).toBe("error")
    expect(outcome.issue[0]?.code).toBe("not-found")
    expect(outcome.issue[0]?.diagnostics).toBe("Patient/p1 not found")
  })

  it("renders a deleted resource as 410", () => {
    const outcome = toOutcome(new Gone({ type: "Patient", id: "p1" }))
    expect(statusOf(new Gone({ type: "Patient", id: "p1" }))).toBe(410)
    expect(outcome.issue[0]?.code).toBe("deleted")
  })

  it("renders a rejection as 400 carrying the stated reason", () => {
    const error = new Rejected({ reason: "unknown search parameter: colour" })
    expect(statusOf(error)).toBe(400)
    expect(toOutcome(error).issue[0]?.code).toBe("invalid")
    expect(toOutcome(error).issue[0]?.diagnostics).toBe("unknown search parameter: colour")
  })

  it("renders a refusal as 403 without saying what was hidden", () => {
    const error = new Forbidden({ action: "write" })
    expect(statusOf(error)).toBe(403)
    expect(toOutcome(error).issue[0]?.code).toBe("forbidden")
    expect(toOutcome(error).issue[0]?.diagnostics).toBe("not permitted: write")
  })

  it("renders a conflict as 409", () => {
    expect(statusOf(new Conflict({ reason: "version mismatch" }))).toBe(409)
    expect(toOutcome(new Conflict({ reason: "version mismatch" })).issue[0]?.code).toBe("conflict")
  })

  it("renders an unavailable dependency as 503 naming the dependency only", () => {
    const error = new Unavailable({ dependency: "store" })
    expect(statusOf(error)).toBe(503)
    expect(toOutcome(error).issue[0]?.code).toBe("transient")
    expect(toOutcome(error).issue[0]?.diagnostics).toBe("store unavailable")
  })

  it("never carries a stack, a query, or a cause", () => {
    const rendered = JSON.stringify(toOutcome(new Unavailable({ dependency: "store" })))
    expect(rendered).not.toContain("stack")
    expect(rendered).not.toContain("Error")
    expect(rendered).not.toContain("select")
  })

  it("is a valid outcome for every error it accepts", () => {
    const errors = [
      new NotFound({ type: "Observation", id: "o1" }),
      new Gone({ type: "Observation", id: "o1" }),
      new Rejected({ reason: "bad" }),
      new Forbidden({ action: "read" }),
      new Conflict({ reason: "stale" }),
      new Unavailable({ dependency: "engine" })
    ]
    for (const error of errors) {
      const outcome = toOutcome(error)
      expect(outcome.issue).toHaveLength(1)
      expect(outcome.issue[0]?.severity).toBe("error")
      expect(typeof outcome.issue[0]?.diagnostics).toBe("string")
      expect(statusOf(error)).toBeGreaterThanOrEqual(400)
    }
  })
})
