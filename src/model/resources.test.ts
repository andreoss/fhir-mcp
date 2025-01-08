import { describe, expect, it } from "vitest"
import { definitionOf, types } from "./resources.js"

const child = (type: string, path: ReadonlyArray<string>) => {
  let elements = definitionOf(type)?.elements
  let held
  for (const name of path) {
    held = elements?.[name]
    elements =
      held !== undefined && held.kind === "group" ? held.children : undefined
  }
  return held
}

describe("resource definitions", () => {
  it("declares the types the store declares", () => {
    expect(types()).toEqual([
      "Patient",
      "Observation",
      "Condition",
      "Encounter"
    ])
  })

  it("knows nothing of a type it does not declare", () => {
    expect(definitionOf("Sasquatch")).toBeUndefined()
  })

  it("names the type it defines", () => {
    expect(definitionOf("Patient")?.type).toBe("Patient")
  })

  it("gives every type the elements every resource carries", () => {
    for (const type of types()) {
      expect(child(type, ["id"])).toEqual({ kind: "id", card: "0..1" })
      expect(child(type, ["meta", "lastUpdated"])).toEqual({
        kind: "instant",
        card: "0..1"
      })
      expect(child(type, ["implicitRules"])?.kind).toBe("uri")
      expect(child(type, ["language"])?.kind).toBe("code")
      expect(child(type, ["text", "status"])).toEqual({
        kind: "code",
        card: "1..1"
      })
      expect(child(type, ["text", "div"])).toEqual({
        kind: "string",
        card: "1..1"
      })
      for (const name of ["contained", "extension", "modifierExtension"]) {
        expect(child(type, [name])).toEqual({ kind: "open", card: "0..*" })
      }
    }
  })

  it("declares the elements the store searches on", () => {
    expect(child("Patient", ["name", "family"])?.kind).toBe("string")
    expect(child("Patient", ["name", "given"])?.card).toBe("0..*")
    expect(child("Patient", ["birthDate"])?.kind).toBe("date")
    expect(child("Patient", ["identifier", "value"])?.kind).toBe("string")
    expect(child("Patient", ["gender"])?.kind).toBe("code")
    expect(child("Observation", ["status"])?.card).toBe("1..1")
    expect(child("Observation", ["code", "coding", "code"])?.kind).toBe("code")
    expect(child("Observation", ["subject", "reference"])?.kind).toBe("string")
    expect(child("Condition", ["clinicalStatus", "coding", "code"])?.kind)
      .toBe("code")
    expect(child("Condition", ["code", "coding", "code"])?.kind).toBe("code")
    expect(child("Condition", ["subject", "reference"])?.kind).toBe("string")
    expect(child("Encounter", ["status"])?.kind).toBe("code")
    expect(child("Encounter", ["subject", "reference"])?.kind).toBe("string")
  })

  it("declares what each type requires", () => {
    expect(child("Observation", ["code"])?.card).toBe("1..1")
    expect(child("Condition", ["subject"])?.card).toBe("1..1")
    expect(child("Encounter", ["class"])?.card).toBe("1..1")
    expect(child("Patient", ["name"])?.card).toBe("0..*")
  })

  it("nests backbone elements more than one level deep", () => {
    expect(child("Encounter", ["participant", "individual", "display"])?.kind)
      .toBe("string")
    expect(child("Observation", ["component", "code", "text"])?.kind)
      .toBe("string")
  })
})
