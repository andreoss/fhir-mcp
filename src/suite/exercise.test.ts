import { describe, expect, it } from "vitest"
import { paramType } from "../conformance/capability.js"
import { REGISTRIES } from "../conformance/versions.js"
import type { Registry } from "../conformance/versions.js"
import { check } from "../model/validate.js"
import { surface } from "../protocol/server.js"
import { bodyOf, faults, sample, stepsOf } from "./exercise.js"
import type { Concept, Step } from "./exercise.js"

const two: Registry = {
  fhirVersion: "4.0.1",
  types: () => ["Patient", "Observation"],
  parametersOf: (type) =>
    type === "Patient"
      ? {
        _id: { path: ["id"] },
        family: { path: ["name", "family"] },
        birthdate: { path: ["birthDate"] }
      }
      : { _id: { path: ["id"] }, status: { path: ["status"] } }
}

const terms: Concept = {
  system: "http://loinc.org",
  code: "1234-5",
  display: "Glucose [Mass/volume] in Serum"
}

const toolsOf = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.map((step) => step.tool)

const argsOf = (step: Step | undefined): Record<string, unknown> =>
  (step?.args ?? {}) as Record<string, unknown>

describe("the exercise the surface is put through", () => {
  it("asks every tool the writable surface serves", () => {
    const asked = new Set(toolsOf(stepsOf(two, { write: true, terms })))
    expect([...asked].sort()).toEqual(surface(true, true).map((tool) => tool.name).sort())
  })

  it("leaves the write tools out when writing is not granted", () => {
    const asked = toolsOf(stepsOf(two, { write: false, terms }))
    for (const tool of ["create", "update", "patch", "delete"]) {
      expect(asked).not.toContain(tool)
    }
    expect(new Set(asked)).toEqual(new Set(["capabilities", "read", "search", "lookup"]))
  })

  it("leaves the lookup out when the build carries no terminology", () => {
    expect(toolsOf(stepsOf(two, { write: true }))).not.toContain("lookup")
  })

  it("asks about the whole surface once and about each declared type", () => {
    const asked = stepsOf(two, { write: true })
      .filter((step) => step.tool === "capabilities")
      .map((step) => argsOf(step)["type"])
    expect(asked).toEqual([undefined, "Patient", "Observation"])
  })

  it("searches every parameter the version declares for the type", () => {
    const searched = stepsOf(two, { write: true })
      .filter((step) => step.tool === "search")
      .map((step) => {
        const args = argsOf(step)
        return [args["type"], Object.keys((args["parameters"] ?? {}) as object)[0]]
      })
    expect(searched).toEqual([
      ["Patient", "_id"],
      ["Patient", "birthdate"],
      ["Patient", "family"],
      ["Observation", "_id"],
      ["Observation", "status"]
    ])
  })

  it("searches a parameter for a value its declared kind takes", () => {
    const searched = stepsOf(two, { write: true }).filter((step) => step.tool === "search")
    const values = searched.map(
      (step) => Object.values((argsOf(step)["parameters"] ?? {}) as object)[0]
    )
    expect(values).toEqual(["agt-9-patient", "2024-01-01", "text", "agt-9-observation", "v"])
  })

  it("walks one record of each type through the whole write path in order", () => {
    expect(toolsOf(stepsOf(two, { write: true, terms }))).toEqual([
      "capabilities",
      "capabilities",
      "create",
      "read",
      "search",
      "search",
      "search",
      "update",
      "patch",
      "delete",
      "read",
      "capabilities",
      "create",
      "read",
      "search",
      "search",
      "update",
      "patch",
      "delete",
      "read",
      "lookup"
    ])
  })

  it("expects the version each write leaves behind", () => {
    const versions = stepsOf(two, { write: true })
      .filter((step) => step.want.kind === "record")
      .map((step) => (step.want.kind === "record" ? step.want.version : ""))
    expect(versions).toEqual(["1", "1", "2", "3", "1", "1", "2", "3"])
  })

  it("expects the types and parameters the version declares, not a recording", () => {
    const asked = stepsOf(two, { write: true }).filter(
      (step) => step.want.kind === "types" || step.want.kind === "parameters"
    )
    expect(asked.map((step) => step.want)).toEqual([
      { kind: "types", types: ["Patient", "Observation"] },
      { kind: "parameters", type: "Patient", parameters: ["_id", "birthdate", "family"] },
      { kind: "parameters", type: "Observation", parameters: ["_id", "status"] }
    ])
  })

  it("writes a body that differs from the one it created", () => {
    const asked = stepsOf(two, { write: true })
    const created = argsOf(asked.find((step) => step.tool === "create"))["body"]
    const updated = argsOf(asked.find((step) => step.tool === "update"))["body"]
    expect(updated).not.toEqual(created)
  })

  it("gives a body of every declared type the elements its definition requires", () => {
    const registry = REGISTRIES[0]
    if (registry === undefined) throw new Error("no registry")
    for (const type of registry.types()) {
      expect(check(type, bodyOf(type))).toEqual([])
    }
  })

  it("expects a record found for every value it holds and for none besides", () => {
    const totals = stepsOf(two, { write: true })
      .filter((step) => step.tool === "search")
      .map((step) => (step.want.kind === "bundle" ? step.want.total : -1))
    expect(totals).toEqual([1, 0, 0, 1, 1])
  })

  it("expects a read only build to answer a search and refuse a read", () => {
    const asked = stepsOf(two, { write: false, terms })
    expect(toolsOf(asked)).toEqual([
      "capabilities",
      "capabilities",
      "read",
      "search",
      "search",
      "search",
      "capabilities",
      "read",
      "search",
      "search",
      "lookup"
    ])
    expect(asked.map((step) => step.want.kind)).toContain("absent")
  })

  it("asks the lookup for the concept the build loaded", () => {
    const asked = stepsOf(two, { write: true, terms }).find((step) => step.tool === "lookup")
    expect(argsOf(asked)).toEqual({ system: terms.system, code: terms.code })
    expect(asked?.want).toEqual({ kind: "concept", concept: terms })
  })
})

describe("the sample a declared parameter is searched with", () => {
  it("takes a value of the kind the declaration names", () => {
    expect(sample("date")).toBe("2024-01-01")
    expect(sample("token")).toBe("v")
    expect(sample("string")).toBe("text")
    expect(sample("reference")).toBe("Patient/one")
  })

  it("names the kind of a declared path the way the statement does", () => {
    expect(paramType(["birthDate"])).toBe("date")
    expect(sample(paramType(["name", "family"]))).toBe("text")
  })
})

describe("what an answer has to meet", () => {
  it("takes an answer that meets what was expected", () => {
    expect(faults({ kind: "types", types: ["Patient"] }, { resourceTypes: ["Patient"] })).toEqual(
      []
    )
    expect(
      faults(
        { kind: "record", type: "Patient", id: "p1", version: "1" },
        { resourceType: "Patient", id: "p1", meta: { versionId: "1" } }
      )
    ).toEqual([])
    expect(
      faults(
        { kind: "bundle", type: "Patient", total: 1 },
        { resourceType: "Bundle", type: "searchset", total: 1 }
      )
    ).toEqual([])
    expect(faults({ kind: "removed" }, { mode: "soft", changed: true })).toEqual([])
    expect(
      faults({ kind: "absent", code: "deleted" }, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "deleted", diagnostics: "Patient/p1 deleted" }]
      })
    ).toEqual([])
    expect(
      faults({ kind: "concept", concept: terms }, {
        _tag: "Found",
        system: terms.system,
        code: terms.code,
        display: terms.display
      })
    ).toEqual([])
  })

  it("names what an answer got wrong", () => {
    expect(faults({ kind: "types", types: ["Patient"] }, { resourceTypes: [] })).toEqual([
      'resourceTypes: expected ["Patient"], got []'
    ])
    expect(
      faults(
        { kind: "record", type: "Patient", id: "p1", version: "2" },
        { resourceType: "Patient", id: "p1", meta: { versionId: "1" } }
      )
    ).toEqual(['meta.versionId: expected "2", got "1"'])
    expect(
      faults({ kind: "parameters", type: "Patient", parameters: ["_id"] }, {
        type: "Observation",
        parameters: ["_id"]
      })
    ).toEqual(['type: expected "Patient", got "Observation"'])
    expect(
      faults({ kind: "bundle", type: "Patient", total: 0 }, {
        resourceType: "Bundle",
        type: "searchset",
        total: 1
      })
    ).toEqual(['total: expected 0, got 1'])
    expect(faults({ kind: "removed" }, { mode: "hard", changed: true })).toEqual([
      'mode: expected "soft", got "hard"'
    ])
    expect(faults({ kind: "absent", code: "deleted" }, {
      resourceType: "OperationOutcome",
      issue: [{ code: "not-found" }]
    })).toEqual(['issue.code: expected "deleted", got "not-found"'])
    expect(faults({ kind: "concept", concept: terms }, {
      _tag: "Unsupplied",
      system: terms.system,
      code: terms.code,
      display: terms.display
    })).toEqual(['_tag: expected "Found", got "Unsupplied"'])
  })

  it("reports an answer that is not a resource at all", () => {
    expect(faults({ kind: "types", types: ["Patient"] }, "gone")).toEqual([
      'resourceTypes: expected ["Patient"], got []'
    ])
  })
})
