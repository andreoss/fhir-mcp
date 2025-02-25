import { describe, expect, it } from "vitest"
import { flatten, named, refusal } from "./params.js"

describe("repeated search parameters", () => {
  it("carries a single value through as one pair", () => {
    expect(flatten({ family: "Simpson" })).toEqual([["family", "Simpson"]])
  })

  it("expands a list into repeated pairs in the order given", () => {
    expect(flatten({ date: ["ge2024-01-01", "le2024-12-31"] })).toEqual([
      ["date", "ge2024-01-01"],
      ["date", "le2024-12-31"]
    ])
  })

  it("keeps the order of the names around a repeated one", () => {
    expect(flatten({ status: "final", date: ["ge1", "le2"], _count: "5" })).toEqual([
      ["status", "final"],
      ["date", "ge1"],
      ["date", "le2"],
      ["_count", "5"]
    ])
  })

  it("drops nothing and adds nothing for an empty list", () => {
    expect(flatten({ date: [] })).toEqual([])
  })
})

describe("named operations", () => {
  it("names the operations it serves", () => {
    expect(named()).toContain("$everything")
    expect(named()).toContain("$docref")
  })

  it("accepts an instance operation on its own type", () => {
    expect(refusal("$everything", "Patient", "instance")).toBeUndefined()
  })

  it("accepts a type operation on its own type", () => {
    expect(refusal("$docref", "DocumentReference", "type")).toBeUndefined()
  })

  it("refuses an unknown operation by name", () => {
    expect(refusal("$expunge", "Patient", "instance")).toContain("$expunge")
  })

  it("refuses an operation on a type it is not defined on", () => {
    expect(refusal("$everything", "Observation", "instance")).toContain("Observation")
  })

  it("refuses an instance operation reached without an id", () => {
    expect(refusal("$everything", "Patient", "type")).toContain("id")
  })

  it("refuses a type operation reached with an id", () => {
    expect(refusal("$docref", "DocumentReference", "instance")).toContain("id")
  })
})
