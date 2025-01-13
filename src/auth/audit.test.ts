import { describe, expect, it } from "vitest"
import { record } from "../agent/audit.js"
import { event } from "./audit.js"

describe("audit event, SEC-06", () => {
  it("carries actor, action and resource for a read", () => {
    const entry = event({
      correlation: "c1",
      action: "read",
      type: "Patient",
      id: "p1",
      outcome: "success",
      token: "secret-bearer"
    })
    expect(entry.action).toBe("read")
    expect(entry.resource).toBe("Patient/p1")
    expect(entry.outcome).toBe("success")
    expect(entry.correlation).toBe("c1")
    expect(typeof entry.at).toBe("string")
  })

  it("carries actor, action and resource for a write", () => {
    const entry = event({ correlation: "c2", action: "write", type: "Observation", id: "o1", outcome: "success" })
    expect(entry.action).toBe("write")
    expect(entry.resource).toBe("Observation/o1")
  })

  it("names the type alone when no instance was touched", () => {
    expect(event({ correlation: "c3", action: "export", type: "Patient", outcome: "refused" }).resource)
      .toBe("Patient")
  })

  it("carries the actor as a digest, never the token", () => {
    const entry = event({ correlation: "c", action: "read", type: "Patient", outcome: "success", token: "secret-bearer" })
    expect(entry.actor).toHaveLength(64)
    expect(entry.actor).not.toContain("secret-bearer")
    expect(JSON.stringify(entry)).not.toContain("secret-bearer")
  })

  it("digests the actor as the tool trail already does", () => {
    const entry = event({ correlation: "c", action: "read", type: "Patient", outcome: "success", token: "t1" })
    expect(entry.actor).toBe(record({ correlation: "c", tool: "read", outcome: "success", token: "t1" }).actor)
  })

  it("says the actor is unknown when no token was presented", () => {
    expect(event({ correlation: "c", action: "read", type: "Patient", outcome: "refused" }).actor).toBe("anonymous")
  })
})
