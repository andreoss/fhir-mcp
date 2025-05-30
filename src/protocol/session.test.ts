import { describe, expect, it } from "vitest"
import { Session } from "./session.js"

describe("protocol session", () => {
  it("adopts sampling from client capabilities", () => {
    const session = new Session()
    expect(session.sampling).toBe(false)
    session.adopt({ sampling: {} })
    expect(session.sampling).toBe(true)
  })

  it("logs at the level configured and above", () => {
    const session = new Session()
    session.setLogLevel("warning")
    expect(session.canLog("debug")).toBe(false)
    expect(session.canLog("warning")).toBe(true)
    expect(session.canLog("error")).toBe(true)
  })

  it("tracks cancellation of in-flight requests", () => {
    const session = new Session()
    session.cancel(7)
    expect(session.isCancelled(7)).toBe(true)
    expect(session.isCancelled(8)).toBe(false)
  })

  it("tracks resource subscriptions by uri", () => {
    const session = new Session()
    session.subscribe("fhir://Patient/1")
    expect(session.isSubscribed("fhir://Patient/1")).toBe(true)
    session.unsubscribe("fhir://Patient/1")
    expect(session.isSubscribed("fhir://Patient/1")).toBe(false)
  })
})