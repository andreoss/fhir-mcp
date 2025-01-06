import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Rejected } from "../core/outcome.js"
import { controls, isControl } from "./control.js"
import type { Controls } from "./control.js"

const ok = (type: string, entries: ReadonlyArray<readonly [string, string]>): Controls => {
  const exit = Effect.runSyncExit(controls(type, entries))
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected controls")
}

const bad = (type: string, entries: ReadonlyArray<readonly [string, string]>): string => {
  const exit = Effect.runSyncExit(controls(type, entries))
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    const error = exit.cause.error
    if (error instanceof Rejected) return error.reason
  }
  throw new Error("expected a refusal")
}

describe("result control parameters", () => {
  it("names the parameters it owns", () => {
    for (const name of [
      "_count",
      "_sort",
      "_elements",
      "_summary",
      "_total",
      "_include",
      "_revinclude"
    ]) {
      expect(isControl(name)).toBe(true)
    }
    expect(isControl("family")).toBe(false)
  })

  it("defaults to nothing asked for", () => {
    const settings = ok("Patient", [])
    expect(settings.count).toBeUndefined()
    expect(settings.sort).toEqual([])
    expect(settings.elements).toEqual([])
    expect(settings.summary).toBeUndefined()
    expect(settings.total).toBeUndefined()
    expect(settings.include).toEqual([])
    expect(settings.revinclude).toEqual([])
  })

  it("reads a page size", () => {
    expect(ok("Patient", [["_count", "50"]]).count).toBe(50)
    expect(ok("Patient", [["_count", "0"]]).count).toBe(0)
  })

  it("refuses a page size that is not a whole count", () => {
    expect(bad("Patient", [["_count", "many"]])).toContain("_count")
    expect(bad("Patient", [["_count", "-1"]])).toContain("_count")
    expect(bad("Patient", [["_count", "2.5"]])).toContain("_count")
  })

  it("reads a sort order, descending on a leading dash", () => {
    expect(ok("Patient", [["_sort", "-birthdate,family"]]).sort).toEqual([
      { name: "birthdate", descending: true },
      { name: "family", descending: false }
    ])
  })

  it("sorts on a common parameter", () => {
    expect(ok("Patient", [["_sort", "_lastUpdated"]]).sort).toEqual([
      { name: "_lastUpdated", descending: false }
    ])
  })

  it("refuses a sort on a parameter the type does not declare", () => {
    expect(bad("Patient", [["_sort", "shoesize"]])).toContain("shoesize")
    expect(bad("Patient", [["_sort", "-"]])).toContain("_sort")
  })

  it("reads the elements to keep", () => {
    expect(ok("Patient", [["_elements", "name,birthDate"]]).elements).toEqual([
      "name",
      "birthDate"
    ])
  })

  it("refuses an empty element name", () => {
    expect(bad("Patient", [["_elements", "name,"]])).toContain("_elements")
  })

  it("reads every summary form", () => {
    for (const form of ["true", "false", "text", "data", "count"]) {
      expect(ok("Patient", [["_summary", form]]).summary).toBe(form)
    }
  })

  it("refuses a summary form it does not know", () => {
    expect(bad("Patient", [["_summary", "loud"]])).toContain("_summary")
  })

  it("reads accurate, estimate and none as totals", () => {
    for (const form of ["accurate", "estimate", "none"]) {
      expect(ok("Patient", [["_total", form]]).total).toBe(form)
    }
  })

  it("refuses a total it does not know", () => {
    expect(bad("Patient", [["_total", "roughly"]])).toContain("_total")
  })

  it("reads an include with a target", () => {
    expect(ok("Patient", [["_include", "Observation:subject:Patient"]]).include).toEqual([
      { source: "Observation", param: "subject", target: "Patient", iterate: false, wildcard: false }
    ])
  })

  it("reads an include without a target", () => {
    expect(ok("Patient", [["_include", "Observation:patient"]]).include[0]).toMatchObject({
      source: "Observation",
      param: "patient",
      target: undefined
    })
  })

  it("marks an iterating include", () => {
    expect(ok("Patient", [["_include:iterate", "Observation:patient"]]).include[0]?.iterate).toBe(
      true
    )
    expect(ok("Patient", [["_include:recurse", "Observation:patient"]]).include[0]?.iterate).toBe(
      true
    )
  })

  it("reads a wildcard over everything and over one type", () => {
    expect(ok("Patient", [["_include", "*"]]).include[0]).toMatchObject({
      source: "*",
      param: "*",
      wildcard: true
    })
    expect(ok("Patient", [["_include", "Observation:*"]]).include[0]).toMatchObject({
      source: "Observation",
      param: "*",
      wildcard: true
    })
  })

  it("reads a reverse include", () => {
    expect(ok("Patient", [["_revinclude", "Observation:patient"]]).revinclude[0]).toMatchObject({
      source: "Observation",
      param: "patient"
    })
    expect(ok("Patient", [["_revinclude", "Observation:patient"]]).include).toEqual([])
  })

  it("collects every include asked for", () => {
    const settings = ok("Patient", [
      ["_include", "Observation:patient"],
      ["_include", "Observation:encounter"]
    ])
    expect(settings.include).toHaveLength(2)
  })

  it("refuses an include naming a type that is not served", () => {
    expect(bad("Patient", [["_include", "Sasquatch:patient"]])).toContain("Sasquatch")
  })

  it("refuses an include naming a parameter that is not declared", () => {
    expect(bad("Patient", [["_include", "Observation:owner"]])).toContain("owner")
  })

  it("refuses an include on a parameter that is not a reference", () => {
    expect(bad("Patient", [["_include", "Observation:status"]])).toContain("status")
  })

  it("refuses an include whose target the parameter cannot reach", () => {
    expect(bad("Patient", [["_include", "Observation:patient:Encounter"]])).toContain("Encounter")
  })

  it("refuses an include of the wrong shape", () => {
    expect(bad("Patient", [["_include", "Observation:patient:Patient:extra"]])).toContain(
      "_include"
    )
    expect(bad("Patient", [["_include", "Observation"]])).toContain("_include")
  })

  it("refuses an unknown modifier on an include", () => {
    expect(bad("Patient", [["_include:sideways", "Observation:patient"]])).toContain("sideways")
  })

  it("refuses a modifier on a control that takes none", () => {
    expect(bad("Patient", [["_count:exact", "5"]])).toContain("_count")
  })

  it("takes the last value when a control is repeated", () => {
    expect(ok("Patient", [["_count", "10"], ["_count", "20"]]).count).toBe(20)
  })
})
