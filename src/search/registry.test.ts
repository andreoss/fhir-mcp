import { describe, expect, it } from "vitest"
import { parametersOf, types } from "../store/definitions.js"
import { ORDERED, allows, isType, paramsOf } from "./registry.js"
import type { ValueType } from "./tree.js"

const declared: Record<string, Record<string, ValueType>> = {
  Patient: {
    family: "string",
    given: "string",
    birthdate: "date",
    identifier: "token",
    gender: "token"
  },
  Observation: { status: "token", code: "token", subject: "reference" },
  Condition: { clinicalstatus: "token", code: "token", subject: "reference" },
  Encounter: { status: "token", subject: "reference" }
}

describe("parameter registry", () => {
  it("gives a value type to every parameter the store declares", () => {
    for (const type of types()) {
      const known = paramsOf(type) ?? {}
      for (const name of Object.keys(parametersOf(type) ?? {})) {
        expect(known[name]).toBeDefined()
        const expected = declared[type]?.[name]
        if (expected !== undefined) expect(known[name]?.valueType).toBe(expected)
      }
    }
  })

  it("knows nothing of a type the store does not declare", () => {
    expect(paramsOf("Sasquatch")).toBeUndefined()
  })

  it("carries the common parameters on every type", () => {
    const patient = paramsOf("Patient") ?? {}
    expect(patient["_id"]?.valueType).toBe("token")
    expect(patient["_lastUpdated"]?.valueType).toBe("date")
    expect(patient["_profile"]?.valueType).toBe("uri")
    expect(patient["_tag"]?.valueType).toBe("token")
    expect(patient["_security"]?.valueType).toBe("token")
    expect(patient["_list"]?.valueType).toBe("string")
    expect(patient["_type"]?.valueType).toBe("token")
  })

  it("names the targets of a reference", () => {
    expect(paramsOf("Observation")?.["patient"]?.targets).toEqual(["Patient"])
    expect(paramsOf("Observation")?.["subject"]?.targets).toContain("Patient")
    expect(paramsOf("Observation")?.["subject"]?.targets.length).toBeGreaterThan(1)
  })

  it("names the components of a composite", () => {
    const composite = paramsOf("Observation")?.["code-value-quantity"]
    expect(composite?.valueType).toBe("composite")
    expect(composite?.components.map((part) => part.valueType)).toEqual(["token", "quantity"])
  })

  it("carries a number and a quantity parameter", () => {
    expect(paramsOf("Encounter")?.["length"]?.valueType).toBe("number")
    expect(paramsOf("Observation")?.["value-quantity"]?.valueType).toBe("quantity")
  })

  it("recognises a declared resource type", () => {
    expect(isType("Patient")).toBe(true)
    expect(isType("Sasquatch")).toBe(false)
  })

  it("orders only number, date and quantity", () => {
    expect(ORDERED.has("number")).toBe(true)
    expect(ORDERED.has("date")).toBe(true)
    expect(ORDERED.has("quantity")).toBe(true)
    expect(ORDERED.has("string")).toBe(false)
    expect(ORDERED.has("token")).toBe(false)
  })

  it("allows a modifier only where the value type carries it", () => {
    expect(allows("string", "exact")).toBe(true)
    expect(allows("string", "contains")).toBe(true)
    expect(allows("token", "exact")).toBe(false)
    expect(allows("token", "text")).toBe(true)
    expect(allows("token", "of-type")).toBe(true)
    expect(allows("token", "in")).toBe(true)
    expect(allows("token", "not-in")).toBe(true)
    expect(allows("reference", "identifier")).toBe(true)
    expect(allows("reference", "type")).toBe(true)
    expect(allows("reference", "exact")).toBe(false)
    expect(allows("uri", "below")).toBe(true)
    expect(allows("uri", "above")).toBe(true)
    expect(allows("date", "exact")).toBe(false)
    expect(allows("number", "contains")).toBe(false)
    expect(allows("quantity", "not")).toBe(false)
    expect(allows("composite", "exact")).toBe(false)
  })

  it("allows missing on every value type", () => {
    const all: ReadonlyArray<ValueType> = [
      "number",
      "date",
      "string",
      "token",
      "quantity",
      "reference",
      "composite",
      "uri"
    ]
    for (const valueType of all) expect(allows(valueType, "missing")).toBe(true)
  })
})
