import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { allows, grant } from "../auth/scope.js"
import { manager } from "../compartment/definition.js"
import { limitsOf as granted } from "../compartment/grant.js"
import { member, restricted } from "../compartment/filter.js"
import type { Limit } from "../compartment/filter.js"
import { parse } from "../search/parse.js"
import type { Query } from "../search/parse.js"
import { CurrentSubject, compartmentOf, known, labelled, limitsOf, scopeOf } from "./subject.js"
import type { Subject } from "./subject.js"

const patient: Subject = { id: "p1", kind: "patient" }
const clinician: Subject = { id: "u1", kind: "user" }

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)

const queryOf = (type: string): Query => run(parse(type, []))

describe("AGT-12 the authenticated subject is knowable", () => {
  it("names the subject the call was made as", () => {
    const found = run(Effect.provideService(known, CurrentSubject, patient))
    expect(found).toEqual(patient)
    expect(labelled(found)).toBe("patient:p1")
  })

  it("says the subject is anonymous when no subject was authenticated", () => {
    expect(run(known).id).toBe("anonymous")
  })

  it("carries the subject out of the call context it was put into", () => {
    const effect = Effect.gen(function* () {
      return yield* known
    })
    const found = run(Effect.provideService(effect, CurrentSubject, clinician))
    expect(found.id).toBe("u1")
    expect(labelled(found)).toBe("user:u1")
  })
})

describe("AGT-12 a compartment restriction binds to the subject", () => {
  it("restricts a patient subject to the compartment it is", () => {
    const limits = limitsOf(patient)
    expect(limits).toHaveLength(1)
    const limit = limits[0] as Limit
    expect(limit.ids).toEqual(["p1"])
    expect(limit.definition.code).toBe("patient")
  })

  it("carries no compartment for a subject that is not in one", () => {
    expect(limitsOf(clinician)).toEqual([])
    expect(compartmentOf(clinician)).toBeUndefined()
    expect(compartmentOf(patient)).toBe("p1")
  })

  it("binds a search for the subject itself to its own id", () => {
    const limit = limitsOf(patient)[0] as Limit
    const expr = member(limit, "Patient")
    expect(JSON.stringify(expr)).toContain("p1")
    expect(JSON.stringify(expr)).toContain("_id")
  })

  it("binds a search for another type to the subject it points at", () => {
    const limit = limitsOf(patient)[0] as Limit
    const expr = member(limit, "Observation")
    expect(JSON.stringify(expr)).toContain("p1")
    expect(JSON.stringify(expr)).toContain("Patient")
  })

  it("reaches the engine restriction a grant for this subject yields", () => {
    const found = run(
      Effect.gen(function* () {
        const registry = yield* manager()
        return yield* granted(
          registry,
          grant([scopeOf(patient, "Observation", "read")]),
          { action: "read", type: "Observation", kind: "patient", compartment: patient.id }
        )
      })
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.ids).toEqual(["p1"])
  })

  it("grants the subject its own compartment and no other", () => {
    const scopes = grant([scopeOf(patient, "Observation", "read")])
    expect(
      allows(scopes, { action: "read", type: "Observation", kind: "patient", compartment: "p1" })
    ).toBe(true)
    expect(
      allows(scopes, { action: "read", type: "Observation", kind: "patient", compartment: "p2" })
    ).toBe(false)
  })

  it("leaves a query for a subject with no compartment alone", () => {
    const query = queryOf("Observation")
    expect(restricted(query, limitsOf(clinician))).toEqual(query)
  })

  it("rewrites a query to the compartment the subject binds", () => {
    const query = restricted(queryOf("Observation"), limitsOf(patient))
    expect(query.expr).toBeDefined()
    expect(JSON.stringify(query.expr)).toContain("p1")
  })
})
