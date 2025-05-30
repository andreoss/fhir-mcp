import { describe, expect, it } from "vitest"
import { TEMPLATES, address, uriOf } from "./resources.js"

describe("protocol resources", () => {
  it("addresses the index of a type", () => {
    const uri = uriOf("Patient")
    expect(address(uri)).toEqual({ type: "Patient" })
  })

  it("addresses a resource by type and id", () => {
    const uri = uriOf("Patient", "p1")
    expect(address(uri)).toEqual({ type: "Patient", id: "p1" })
  })

  it("addresses one version of a resource", () => {
    const uri = uriOf("Patient", "p1", "3")
    expect(address(uri)).toEqual({ type: "Patient", id: "p1", version: "3" })
  })

  it("refuses an address outside the served space", () => {
    expect(address("file:///etc/passwd")).toBeUndefined()
    expect(address("fhir://Patient/")).toBeUndefined()
  })

  it("offers templates that name every uri shape", () => {
    const templates = TEMPLATES.map((one) => one.uriTemplate)
    expect(templates).toContain("fhir://{type}/{id}")
    expect(templates).toContain("fhir://{type}/{id}/_history/{version}")
  })
})