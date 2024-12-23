import { describe, expect, it } from "vitest"
import { record } from "./audit.js"

describe("audit record", () => {
  it("names the call, the outcome and the correlation", () => {
    const entry = record({
      correlation: "c1",
      tool: "read",
      type: "Patient",
      id: "p1",
      outcome: "success"
    })
    expect(entry.tool).toBe("read")
    expect(entry.type).toBe("Patient")
    expect(entry.id).toBe("p1")
    expect(entry.outcome).toBe("success")
    expect(entry.correlation).toBe("c1")
    expect(typeof entry.at).toBe("string")
  })

  it("carries a token as a digest, never as the token", () => {
    const entry = record({ correlation: "c1", tool: "read", outcome: "success", token: "secret-bearer" })
    expect(entry.actor).toBeDefined()
    expect(entry.actor).not.toContain("secret-bearer")
    expect(entry.actor).toHaveLength(64)
  })

  it("gives the same digest for the same token and a different one otherwise", () => {
    const a = record({ correlation: "c", tool: "read", outcome: "success", token: "t1" })
    const b = record({ correlation: "c", tool: "read", outcome: "success", token: "t1" })
    const c = record({ correlation: "c", tool: "read", outcome: "success", token: "t2" })
    expect(a.actor).toBe(b.actor)
    expect(a.actor).not.toBe(c.actor)
  })

  it("says the actor is unknown when no token was presented", () => {
    expect(record({ correlation: "c", tool: "read", outcome: "success" }).actor).toBe("anonymous")
  })

  it("never carries the arguments a call was made with", () => {
    const entry = record({
      correlation: "c",
      tool: "search",
      type: "Patient",
      outcome: "refused",
      parameters: ["family", "birthdate"]
    })
    expect(JSON.stringify(entry)).not.toContain("Simpson")
    expect(entry.parameters).toEqual(["family", "birthdate"])
  })
})
