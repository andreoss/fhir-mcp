import { describe, expect, it } from "vitest"
import { keep } from "./elements.js"

const patient = {
  resourceType: "Patient",
  id: "p1",
  name: [{ family: "Simpson", given: ["Homer"] }],
  birthDate: "1956-05-12",
  address: [{ city: "Springfield", line: ["742 Evergreen Terrace"] }]
}

describe("element selection", () => {
  it("returns the resource untouched when nothing is asked for", () => {
    expect(keep(patient, [])).toEqual(patient)
  })

  it("keeps only what was asked for, and what identifies the resource", () => {
    expect(keep(patient, ["birthDate"])).toEqual({
      resourceType: "Patient",
      id: "p1",
      birthDate: "1956-05-12"
    })
  })

  it("keeps a nested path without the rest of its parent", () => {
    expect(keep(patient, ["name.family"])).toEqual({
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "Simpson" }]
    })
  })

  it("keeps several paths at once", () => {
    expect(keep(patient, ["name.family", "address.city"])).toEqual({
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "Simpson" }],
      address: [{ city: "Springfield" }]
    })
  })

  it("leaves out a path the resource does not carry", () => {
    expect(keep(patient, ["telecom.value"])).toEqual({ resourceType: "Patient", id: "p1" })
  })

  it("does not invent an entry for an empty array", () => {
    expect(keep({ resourceType: "Patient", id: "p1", name: [] }, ["name.family"]))
      .toEqual({ resourceType: "Patient", id: "p1" })
  })

  it("keeps a whole branch when the branch itself is named", () => {
    expect(keep(patient, ["name"])).toEqual({
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "Simpson", given: ["Homer"] }]
    })
  })
})

describe("element selection, overlapping paths", () => {
  it("merges two paths that share a parent array", () => {
    const resource = {
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "Simpson", given: ["Homer"], prefix: ["Mr"] }]
    }
    expect(keep(resource, ["name.family", "name.given"])).toEqual({
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "Simpson", given: ["Homer"] }]
    })
  })

  it("merges two paths that share a parent object", () => {
    const resource = {
      resourceType: "Observation",
      id: "o1",
      code: { text: "glucose", coding: [{ code: "1", system: "s" }] }
    }
    expect(keep(resource, ["code.text", "code.coding.code"])).toEqual({
      resourceType: "Observation",
      id: "o1",
      code: { text: "glucose", coding: [{ code: "1" }] }
    })
  })

  it("keeps entries of unequal length without dropping either", () => {
    const resource = {
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "A", given: ["x"] }, { family: "B" }]
    }
    expect(keep(resource, ["name.family", "name.given"])).toEqual({
      resourceType: "Patient",
      id: "p1",
      name: [{ family: "A", given: ["x"] }, { family: "B" }]
    })
  })

  it("keeps a resource that carries no id", () => {
    expect(keep({ resourceType: "Patient", gender: "male" }, ["gender"]))
      .toEqual({ resourceType: "Patient", gender: "male" })
  })

  it("ignores a path that reaches a plain value and then asks for more", () => {
    expect(keep({ resourceType: "Patient", id: "p1", gender: "male" }, ["gender.text"]))
      .toEqual({ resourceType: "Patient", id: "p1" })
  })
})
