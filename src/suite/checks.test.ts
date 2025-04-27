import { describe, expect, it } from "vitest"
import { statement } from "../conformance/capability.js"
import type { CapabilityStatement } from "../conformance/capability.js"
import { REGISTRIES } from "../conformance/versions.js"
import { surface } from "../protocol/server.js"
import { checksOf, verify } from "./checks.js"
import type { Observed } from "./checks.js"

const build = { software: { name: "fhir-mcp", version: "0.0.0" }, date: "2026-01-01" }

const registry = REGISTRIES[0]

const derived = () => {
  if (registry === undefined) throw new Error("no registry")
  return checksOf(statement(build, registry, surface(true)))
}

const ids = () => derived().map((check) => check.id)

const seen: Observed = {
  tools: ["read", "search", "capabilities", "create", "update", "delete", "patch"],
  types: ["Patient", "Observation", "Condition", "Encounter"],
  params: {
    Patient: ["_id", "family", "given", "birthdate", "identifier", "gender"],
    Observation: ["_id", "status", "code", "subject"],
    Condition: ["_id", "clinicalstatus", "code", "subject"],
    Encounter: ["_id", "status", "subject"]
  }
}

describe("checks derived from the capability statement", () => {
  it("names one check per interaction the statement declares", () => {
    expect(ids()).toContain("interaction:read")
    expect(ids()).toContain("interaction:create")
    expect(ids()).toContain("interaction:patch")
    expect(ids()).toContain("system:capabilities")
  })

  it("names one check per resource type and declared parameter", () => {
    expect(ids()).toContain("type:Patient")
    expect(ids()).toContain("param:Patient.family")
    expect(ids()).toContain("param:Observation.code")
  })

  it("claims nothing the statement does not declare", () => {
    expect(ids()).not.toContain("interaction:vread")
    expect(ids()).not.toContain("system:transaction")
    expect(ids()).not.toContain("type:Practitioner")
  })

  it("drops the write interactions when the build serves none", () => {
    if (registry === undefined) throw new Error("no registry")
    const readOnly = checksOf(statement(build, registry, surface(false)))
    const named = readOnly.map((check) => check.id)
    expect(named).toContain("interaction:read")
    expect(named).not.toContain("interaction:create")
  })

  it("orders the list and names each check once", () => {
    const named = ids()
    expect([...named].sort((a, b) => a.localeCompare(b))).toEqual(named)
    expect(new Set(named).size).toBe(named.length)
  })
})

describe("checks against a running server", () => {
  it("meets every check when the server serves what it declares", () => {
    const verdicts = verify(derived(), seen)
    expect(verdicts.filter((one) => !one.met)).toEqual([])
    expect(verdicts.length).toBe(derived().length)
  })

  it("names the tool a server stops listing", () => {
    const verdicts = verify(derived(), {
      ...seen,
      tools: seen.tools.filter((name) => name !== "patch")
    })
    expect(verdicts.filter((one) => !one.met).map((one) => one.id)).toEqual([
      "interaction:patch"
    ])
  })

  it("names the type a server stops serving", () => {
    const verdicts = verify(derived(), { ...seen, types: ["Patient"] })
    const missed = verdicts.filter((one) => !one.met).map((one) => one.id)
    expect(missed).toContain("type:Observation")
    expect(missed).not.toContain("type:Patient")
  })

  it("names the parameter a type stops accepting", () => {
    const verdicts = verify(derived(), {
      ...seen,
      params: { ...seen.params, Patient: ["_id"] }
    })
    const missed = verdicts.filter((one) => !one.met).map((one) => one.id)
    expect(missed).toContain("param:Patient.family")
    expect(missed).not.toContain("param:Patient._id")
  })

  it("treats a type it never asked about as serving no parameter", () => {
    const verdicts = verify(derived(), { ...seen, params: {} })
    expect(verdicts.filter((one) => !one.met).map((one) => one.id)).toContain(
      "param:Patient.family"
    )
  })
})

describe("a statement that names an interaction no tool provides", () => {
  const declared: CapabilityStatement = {
    resourceType: "CapabilityStatement",
    status: "active",
    kind: "instance",
    date: "recorded",
    software: { name: "fhir-mcp", version: "0.0.0" },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        interaction: [{ code: "search-compartment" }, { code: "capabilities" }],
        resource: [
          {
            type: "Patient",
            interaction: [{ code: "search-compartment" }, { code: "read" }],
            searchParam: [{ name: "family", type: "string" }]
          }
        ]
      }
    ]
  }

  it("checks only what a tool can answer for", () => {
    expect(checksOf(declared).map((check) => check.id)).toEqual([
      "interaction:read",
      "param:Patient.family",
      "system:capabilities",
      "type:Patient"
    ])
  })

  it("meets nothing when the server serves nothing", () => {
    const verdicts = verify(checksOf(declared), { tools: [], types: [], params: {} })
    expect(verdicts.every((one) => !one.met)).toBe(true)
  })
})

describe("a tool no interaction of the statement covers", () => {
  const offered = surface(true, true).map((tool) => tool.name)

  const derived = () => {
    if (registry === undefined) throw new Error("no registry")
    return checksOf(statement(build, registry, surface(true, true)), offered)
  }

  it("names a check of its own for the tool", () => {
    expect(derived().map((check) => check.id)).toContain("tool:lookup")
  })

  it("names no second check for a tool an interaction already covers", () => {
    const named = derived().map((check) => check.id)
    expect(named).toContain("system:capabilities")
    expect(named).not.toContain("tool:capabilities")
    expect(named).not.toContain("tool:read")
  })

  it("leaves the tool out when the surface does not serve it", () => {
    if (registry === undefined) throw new Error("no registry")
    const named = checksOf(
      statement(build, registry, surface(true)),
      surface(true).map((tool) => tool.name)
    ).map((check) => check.id)
    expect(named).not.toContain("tool:lookup")
  })

  it("meets the check only once the server lists the tool", () => {
    expect(verify(derived(), seen).filter((one) => !one.met).map((one) => one.id)).toEqual([
      "tool:lookup"
    ])
    const listed = { ...seen, tools: [...seen.tools, "lookup"] }
    expect(verify(derived(), listed).filter((one) => !one.met)).toEqual([])
  })
})
