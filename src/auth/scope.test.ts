import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Forbidden } from "../core/outcome.js"
import { ACTIONS, allows, check, covers, grant } from "./scope.js"

const held = <A>(exit: Exit.Exit<A, Forbidden>): Forbidden => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

describe("scope grammar", () => {
  it("names the eight data actions", () => {
    expect(ACTIONS).toEqual([
      "read",
      "write",
      "export",
      "import",
      "reindex",
      "bulk-delete",
      "bulk-update",
      "parameter-management"
    ])
  })

  it("reads a scope for every data action", () => {
    const parsed = grant(ACTIONS.map((action) => `system/*.${action}`))
    expect(parsed.scopes).toHaveLength(ACTIONS.length)
    for (const action of ACTIONS) {
      expect(allows(parsed, { action, type: "Patient", kind: "system" })).toBe(true)
    }
  })

  it("ignores what is not a data scope", () => {
    const parsed = grant(["openid", "profile", "", "user/Patient.read", "nonsense/x.y.z"])
    expect(parsed.scopes).toHaveLength(1)
  })
})

describe("data action scopes, SEC-02", () => {
  it("does not let a read grant write", () => {
    const parsed = grant(["user/Patient.read"])
    expect(allows(parsed, { action: "read", type: "Patient" })).toBe(true)
    expect(allows(parsed, { action: "write", type: "Patient" })).toBe(false)
  })

  it("keeps the bulk and maintenance actions apart", () => {
    const parsed = grant(["system/*.export"])
    expect(allows(parsed, { action: "export", type: "Patient", kind: "system" })).toBe(true)
    expect(allows(parsed, { action: "bulk-delete", type: "Patient", kind: "system" })).toBe(false)
    expect(allows(parsed, { action: "reindex", type: "Patient", kind: "system" })).toBe(false)
    expect(allows(parsed, { action: "parameter-management", type: "Patient", kind: "system" })).toBe(false)
  })

  it("lets a wildcard action cover every action of the type", () => {
    const parsed = grant(["system/Patient.*"])
    for (const action of ACTIONS) {
      expect(allows(parsed, { action, type: "Patient", kind: "system" })).toBe(true)
    }
    expect(allows(parsed, { action: "read", type: "Observation", kind: "system" })).toBe(false)
  })
})

describe("resource and compartment scopes, SEC-03", () => {
  it("binds a scope to the resource type it names", () => {
    const parsed = grant(["user/Observation.read"])
    expect(allows(parsed, { action: "read", type: "Observation" })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Patient" })).toBe(false)
  })

  it("lets a wildcard type cover any type", () => {
    expect(allows(grant(["user/*.read"]), { action: "read", type: "Anything" })).toBe(true)
  })

  it("lets a broader compartment cover a narrower request", () => {
    const parsed = grant(["system/Patient.read"])
    expect(allows(parsed, { action: "read", type: "Patient", kind: "system" })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Patient", kind: "user" })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Patient", kind: "patient" })).toBe(true)
  })

  it("does not let a narrower compartment cover a broader request", () => {
    const parsed = grant(["patient/Patient.read"])
    expect(allows(parsed, { action: "read", type: "Patient", kind: "patient" })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Patient", kind: "user" })).toBe(false)
    expect(allows(parsed, { action: "read", type: "Patient", kind: "system" })).toBe(false)
  })

  it("holds a scope pinned to one compartment to that compartment", () => {
    const parsed = grant(["patient:p1/Observation.read"])
    expect(allows(parsed, { action: "read", type: "Observation", kind: "patient", compartment: "p1" })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Observation", kind: "patient", compartment: "p2" })).toBe(false)
    expect(allows(parsed, { action: "read", type: "Observation", kind: "patient" })).toBe(false)
  })

  it("lets an unpinned compartment scope serve any compartment", () => {
    const parsed = grant(["patient/Observation.read"])
    expect(allows(parsed, { action: "read", type: "Observation", kind: "patient", compartment: "p2" })).toBe(true)
  })
})

describe("search parameter grants, SEC-03", () => {
  it("permits only the parameters the grant names", () => {
    const parsed = grant(["user/Patient.read?family,birthdate"])
    expect(allows(parsed, { action: "read", type: "Patient", parameters: ["family"] })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Patient", parameters: ["family", "birthdate"] })).toBe(true)
    expect(allows(parsed, { action: "read", type: "Patient", parameters: ["identifier"] })).toBe(false)
  })

  it("permits any parameter when the grant names none", () => {
    const parsed = grant(["user/Patient.read"])
    expect(allows(parsed, { action: "read", type: "Patient", parameters: ["identifier"] })).toBe(true)
  })

  it("permits a search with no parameters against a parameter grant", () => {
    const parsed = grant(["user/Patient.read?family"])
    expect(allows(parsed, { action: "read", type: "Patient", parameters: [] })).toBe(true)
  })

  it("takes the widest grant when several are held", () => {
    const parsed = grant(["user/Patient.read?family", "user/Patient.read"])
    expect(allows(parsed, { action: "read", type: "Patient", parameters: ["identifier"] })).toBe(true)
  })
})

describe("checked access", () => {
  it("passes when the grant covers the access", () => {
    const exit = Effect.runSyncExit(check(grant(["user/Patient.read"]), { action: "read", type: "Patient" }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("refuses with the action and the type it refused", () => {
    const exit = Effect.runSyncExit(check(grant(["user/Patient.read"]), { action: "write", type: "Patient" }))
    expect(held(exit)._tag).toBe("Forbidden")
    expect(held(exit).action).toBe("write Patient")
  })

  it("reports whether an action is covered at all", () => {
    const parsed = grant(["user/Patient.read", "system/*.export"])
    expect(covers(parsed, "read")).toBe(true)
    expect(covers(parsed, "export")).toBe(true)
    expect(covers(parsed, "write")).toBe(false)
    expect(covers(grant(["system/*.*"]), "bulk-update")).toBe(true)
  })

  it("holds nothing when no scope was granted", () => {
    expect(allows(grant([]), { action: "read", type: "Patient" })).toBe(false)
    expect(covers(grant([]), "read")).toBe(false)
  })
})
