import { describe, expect, it } from "vitest"
import type { FhirResource } from "../core/engine.js"
import { apply, seal } from "./rules.js"

const patient: FhirResource = {
  resourceType: "Patient",
  id: "p1",
  name: [
    { family: "Vance", given: ["Ada"] },
    { family: "Vance", given: ["Adele"] }
  ],
  telecom: [{ system: "phone", value: "555-0100" }],
  birthDate: "1980-04-01"
}

const set = (location: string, rules: ReadonlyArray<{
  readonly path: string
  readonly act: "redact" | "mask" | "hash"
}>) => seal(location, rules)

describe("anonymization rule sets", () => {
  it("keeps the location it was configured from", () => {
    expect(set("conf/anon.json", []).location).toBe("conf/anon.json")
  })

  it("stamps one etag for one rule set", () => {
    const one = set("a", [{ path: "name.family", act: "redact" }])
    const other = set("b", [{ path: "name.family", act: "redact" }])
    expect(one.etag).toBe(other.etag)
    expect(one.etag).toMatch(/^W\/"[0-9a-f]{12}"$/)
  })

  it("stamps another etag for another rule set", () => {
    const one = set("a", [{ path: "name.family", act: "redact" }])
    const other = set("a", [{ path: "birthDate", act: "redact" }])
    expect(one.etag).not.toBe(other.etag)
  })

  it("redacts an element wherever it repeats", () => {
    const out = apply(set("a", [{ path: "name.family", act: "redact" }]), patient)
    expect(JSON.stringify(out)).not.toContain("Vance")
    expect(out["name"]).toEqual([{ given: ["Ada"] }, { given: ["Adele"] }])
  })

  it("masks a value with a fixed token", () => {
    const out = apply(set("a", [{ path: "birthDate", act: "mask" }]), patient)
    expect(out["birthDate"]).toBe("masked")
  })

  it("hashes a value to a stable pseudonym", () => {
    const rules = set("a", [{ path: "telecom.value", act: "hash" }])
    const first = apply(rules, patient)
    const second = apply(rules, patient)
    const held = (out: FhirResource) =>
      (out["telecom"] as ReadonlyArray<Record<string, unknown>>)[0]?.["value"]
    expect(held(first)).toBe(held(second))
    expect(held(first)).not.toBe("555-0100")
    expect(String(held(first))).toMatch(/^[0-9a-f]{16}$/)
  })

  it("hashes nothing where there is no value to hash", () => {
    const out = apply(set("a", [{ path: "name", act: "hash" }]), patient)
    expect(out["name"]).toBeUndefined()
  })

  it("leaves a resource alone when no rule reaches it", () => {
    const out = apply(set("a", [{ path: "address.city", act: "redact" }]), patient)
    expect(out).toEqual(patient)
  })

  it("refuses to touch the identity of a resource", () => {
    const out = apply(
      set("a", [{ path: "id", act: "redact" }, { path: "resourceType", act: "mask" }]),
      patient
    )
    expect(out.id).toBe("p1")
    expect(out.resourceType).toBe("Patient")
  })

  it("passes a resource through an empty rule set unchanged", () => {
    expect(apply(set("a", []), patient)).toEqual(patient)
  })

  it("steps past a path that does not lead to an object", () => {
    const out = apply(set("a", [{ path: "birthDate.year", act: "redact" }]), patient)
    expect(out["birthDate"]).toBe("1980-04-01")
  })
})
