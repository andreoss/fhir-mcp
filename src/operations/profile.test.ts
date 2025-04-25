import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { make } from "../terminology/terminology.js"
import type { Sources } from "../terminology/system.js"
import { TerminologyPort } from "../terminology/port.js"
import type { Grant } from "./grant.js"
import { enforceProfiles, outcomeOf, profiles, settled } from "./profile.js"
import type { Catalogue, Finding } from "./profile.js"

const all: Grant = { read: true }

const sources: Sources = {
  stored: [
    {
      url: "http://cs/gender",
      content: "complete",
      concept: [{ code: "male" }, { code: "female" }]
    },
    {
      url: "http://cs/marital",
      content: "complete",
      concept: [{ code: "M" }, { code: "S" }]
    }
  ],
  valueSets: [
    { url: "http://vs/gender", include: [{ system: "http://cs/gender" }] },
    { url: "http://vs/marital", include: [{ system: "http://cs/marital" }] },
    { url: "http://vs/nowhere", include: [{ system: "http://cs/missing" }] }
  ]
}

const catalogue: Catalogue = [
  {
    url: "http://profile/patient",
    type: "Patient",
    must: ["gender"],
    binds: [{ path: "gender", valueSet: "http://vs/gender", strength: "required" }]
  },
  {
    url: "http://profile/marital",
    type: "Patient",
    must: [],
    binds: [
      { path: "maritalStatus", valueSet: "http://vs/marital", strength: "extensible" }
    ]
  },
  {
    url: "http://profile/unheld",
    type: "Patient",
    must: [],
    binds: [{ path: "gender", valueSet: "http://vs/unheld", strength: "required" }]
  },
  {
    url: "http://profile/nowhere",
    type: "Patient",
    must: [],
    binds: [{ path: "gender", valueSet: "http://vs/nowhere", strength: "required" }]
  },
  { url: "http://profile/observation", type: "Observation", must: [], binds: [] }
]

const served = <A, E>(effect: Effect.Effect<A, E, TerminologyPort>) =>
  Effect.provideService(effect, TerminologyPort, make(sources))

const ask = (
  type: string,
  body: unknown,
  grant: Grant = all
): Promise<ReadonlyArray<Finding>> =>
  Effect.runPromise(served(profiles(type, body, catalogue, grant)))

const fail = async (type: string, body: unknown, grant: Grant = all): Promise<string> => {
  const result = await Effect.runPromiseExit(served(profiles(type, body, catalogue, grant)))
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const patient = (profile: ReadonlyArray<string>, rest: Record<string, unknown> = {}) => ({
  resourceType: "Patient",
  id: "p1",
  meta: { profile },
  ...rest
})

describe("profile declaration", () => {
  it("finds nothing to say about a resource declaring no profile", async () => {
    const found = await ask("Patient", { resourceType: "Patient", id: "p1" })
    expect(found).toEqual([])
    expect(settled(found)).toBe(true)
  })

  it("accepts a resource that meets the profile it declares", async () => {
    const found = await ask("Patient", patient(["http://profile/patient"], { gender: "male" }))
    expect(found.filter((one) => one.verdict !== "ok")).toEqual([])
    expect(settled(found)).toBe(true)
  })

  it("reports a profile it holds no definition for as unchecked", async () => {
    const found = await ask("Patient", patient(["http://profile/elsewhere"]))
    expect(found).toHaveLength(1)
    expect(found[0]?.rule).toBe("profile")
    expect(found[0]?.verdict).toBe("unchecked")
    expect(found[0]?.detail).toContain("http://profile/elsewhere")
    expect(settled(found)).toBe(false)
  })

  it("reports a profile written for another resource type", async () => {
    const found = await ask("Patient", patient(["http://profile/observation"]))
    expect(found[0]?.verdict).toBe("failed")
    expect(found[0]?.rule).toBe("profile")
  })

  it("reports a declaration that is not a canonical url", async () => {
    const found = await ask("Patient", { resourceType: "Patient", meta: { profile: [7] } })
    expect(found[0]?.verdict).toBe("failed")
    expect(found[0]?.rule).toBe("profile")
  })

  it("passes over a meta that carries no profile list", async () => {
    expect(await ask("Patient", { resourceType: "Patient", meta: { profile: "one" } })).toEqual([])
  })

  it("reports an element the profile requires and the resource lacks", async () => {
    const found = await ask("Patient", patient(["http://profile/patient"]))
    const missing = found.find((one) => one.rule === "cardinality")
    expect(missing?.verdict).toBe("failed")
    expect(missing?.path).toBe("Patient.gender")
  })

  it("refuses a body that is not the type it is checked against", async () => {
    expect(await fail("Patient", { resourceType: "Observation" })).toBe("Rejected")
    expect(await fail("Patient", "not a resource")).toBe("Rejected")
  })

  it("refuses a type the grant does not cover", async () => {
    expect(await fail("Patient", patient([]), { read: true, types: ["Observation"] })).toBe(
      "Forbidden"
    )
  })
})

describe("bound value sets", () => {
  it("accepts a code the value set holds", async () => {
    const found = await ask("Patient", patient(["http://profile/patient"], { gender: "female" }))
    expect(found.filter((one) => one.rule === "binding" && one.verdict !== "ok")).toEqual([])
  })

  it("reports a code the required value set does not hold", async () => {
    const found = await ask("Patient", patient(["http://profile/patient"], { gender: "other" }))
    const binding = found.find((one) => one.rule === "binding")
    expect(binding?.verdict).toBe("failed")
    expect(binding?.detail).toContain("http://vs/gender")
    expect(settled(found)).toBe(false)
  })

  it("reads a code out of a codeable concept", async () => {
    const found = await ask(
      "Patient",
      patient(["http://profile/marital"], {
        maritalStatus: { coding: [{ system: "http://cs/marital", code: "M" }] }
      })
    )
    expect(found.filter((one) => one.verdict !== "ok")).toEqual([])
  })

  it("lets an extensible binding carry a code from another system", async () => {
    const found = await ask(
      "Patient",
      patient(["http://profile/marital"], {
        maritalStatus: { coding: [{ system: "http://cs/local", code: "X" }] }
      })
    )
    expect(found.filter((one) => one.verdict !== "ok")).toEqual([])
  })

  it("reports a code of a bound system that the extensible value set does not hold", async () => {
    const found = await ask(
      "Patient",
      patient(["http://profile/marital"], {
        maritalStatus: { coding: [{ system: "http://cs/marital", code: "Z" }] }
      })
    )
    expect(found.find((one) => one.rule === "binding")?.verdict).toBe("failed")
  })

  it("says nothing about a binding whose element is absent", async () => {
    const found = await ask("Patient", patient(["http://profile/marital"]))
    expect(found).toEqual([])
  })
})

describe("bindings that cannot be resolved", () => {
  it("reports a value set it cannot resolve as unchecked, never as met", async () => {
    const found = await ask("Patient", patient(["http://profile/unheld"], { gender: "male" }))
    const binding = found.find((one) => one.rule === "binding")
    expect(binding?.verdict).toBe("unchecked")
    expect(binding?.detail).toContain("http://vs/unheld")
    expect(found.some((one) => one.verdict === "ok" && one.rule === "binding")).toBe(false)
    expect(settled(found)).toBe(false)
  })

  it("reports a value set whose code system carries no content as unchecked", async () => {
    const found = await ask("Patient", patient(["http://profile/nowhere"], { gender: "male" }))
    const binding = found.find((one) => one.rule === "binding")
    expect(binding?.verdict).toBe("unchecked")
    expect(binding?.detail).toContain("http://cs/missing")
  })

  it("says an unchecked binding is not an error of the resource", async () => {
    const found = await ask("Patient", patient(["http://profile/unheld"], { gender: "male" }))
    expect(outcomeOf(found).issue[0]?.code).toBe("not-found")
    expect(outcomeOf(found).issue[0]?.diagnostics).toContain("unchecked")
  })
})

describe("reported outcome", () => {
  it("holds no issue when everything was met", async () => {
    const found = await ask("Patient", patient(["http://profile/patient"], { gender: "male" }))
    expect(outcomeOf(found)).toEqual({ resourceType: "OperationOutcome", issue: [] })
  })

  it("names the rule that failed", async () => {
    const found = await ask("Patient", patient(["http://profile/patient"], { gender: "other" }))
    const issue = outcomeOf(found).issue.find((one) => one.diagnostics.includes("binding"))
    expect(issue?.code).toBe("invalid")
    expect(issue?.diagnostics).toContain("Patient.gender")
  })

  it("lets a resource that met everything through", async () => {
    await Effect.runPromise(
      served(
        enforceProfiles(
          "Patient",
          patient(["http://profile/patient"], { gender: "male" }),
          catalogue,
          all
        )
      )
    )
  })

  it("refuses a resource whose binding could not be checked", async () => {
    const result = await Effect.runPromiseExit(
      served(
        enforceProfiles(
          "Patient",
          patient(["http://profile/unheld"], { gender: "male" }),
          catalogue,
          all
        )
      )
    )
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("bindings under a list", () => {
  const nested: Catalogue = [
    {
      url: "http://profile/language",
      type: "Patient",
      must: [],
      binds: [
        { path: "communication.language", valueSet: "http://vs/marital", strength: "required" },
        { path: "maritalStatus", valueSet: "http://vs/marital", strength: "required" }
      ]
    }
  ]

  const under = (body: unknown): Promise<ReadonlyArray<Finding>> =>
    Effect.runPromise(served(profiles("Patient", body, nested, all)))

  it("reads a code out of an element repeated in a list", async () => {
    const found = await under(
      patient(["http://profile/language"], {
        communication: [{ language: { coding: [{ system: "http://cs/marital", code: "M" }] } }]
      })
    )
    expect(found.filter((one) => one.verdict !== "ok")).toEqual([])
  })

  it("reads codes out of a coded element that repeats", async () => {
    const found = await under(
      patient(["http://profile/language"], {
        maritalStatus: [
          { coding: [{ system: "http://cs/marital", code: "M" }] },
          { coding: [{ system: "http://cs/marital", code: "Z" }] }
        ]
      })
    )
    expect(found.filter((one) => one.verdict === "failed")).toHaveLength(1)
  })

  it("says nothing about a coded element carrying no code", async () => {
    expect(await under(patient(["http://profile/language"], { maritalStatus: { text: "single" } })))
      .toEqual([])
  })
})
