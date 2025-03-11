import { describe, expect, it } from "vitest"
import { parametersOf, types, walk } from "./definitions.js"

describe("definitions", () => {
  it("gives every declared type the common parameters as well as its own", () => {
    expect(Object.keys(parametersOf("Patient") ?? {})).toContain("_id")
    expect(Object.keys(parametersOf("Patient") ?? {})).toContain("family")
  })

  it("knows nothing of a type it does not declare", () => {
    expect(parametersOf("Sasquatch")).toBeUndefined()
  })

  it("names every type it declares", () => {
    expect(types()).toContain("Observation")
    expect(types()).not.toContain("Sasquatch")
  })

  it("reads a value through nested arrays", () => {
    const resource = { name: [{ given: ["Homer", "Jay"] }, { given: ["H"] }] }
    expect(walk(resource, ["name", "given"])).toEqual(["Homer", "Jay", "H"])
  })

  it("renders a number or a boolean as the text it would be matched as", () => {
    expect(walk({ a: 7 }, ["a"])).toEqual(["7"])
    expect(walk({ a: true }, ["a"])).toEqual(["true"])
  })

  it("finds nothing down a path that is not there", () => {
    expect(walk({ a: 1 }, ["b", "c"])).toEqual([])
    expect(walk(null, ["a"])).toEqual([])
    expect(walk("text", ["a"])).toEqual([])
    expect(walk({ a: { b: {} } }, ["a", "b"])).toEqual([])
  })
})
