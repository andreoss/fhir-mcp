import { describe, expect, it } from "vitest"
import { paramType } from "../conformance/capability.js"
import { REGISTRIES } from "../conformance/versions.js"
import type { Registry } from "../conformance/versions.js"
import { check } from "../model/validate.js"
import { surface } from "../protocol/server.js"
import { bodyOf, drive, faults, sample, stepsOf, taken } from "./exercise.js"
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

  it("asks the job tools when the build carries a desk", () => {
    const asked = new Set(toolsOf(stepsOf(two, { write: true, terms, jobs: true })))
    expect([...asked].sort()).toEqual(
      surface(true, true, true).map((tool) => tool.name).sort()
    )
  })

  it("leaves the job tools out when the build carries no desk", () => {
    const asked = toolsOf(stepsOf(two, { write: true, terms }))
    for (const tool of ["job-submit", "job-status", "job-cancel", "job-output"]) {
      expect(asked).not.toContain(tool)
    }
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
      "lookup",
      "transaction",
      "batch"
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

describe("the steps a job is put through", () => {
  const jobbed = (): ReadonlyArray<Step> => stepsOf(two, { write: true, jobs: true })

  it("submits one job and keeps the id it answered", () => {
    const submit = jobbed().find((step) => step.tool === "job-submit")
    expect(argsOf(submit)).toEqual({ kind: "reindex", request: "{}" })
    expect(submit?.keep).toEqual({ name: "job", at: ["id"] })
    expect(submit?.want).toEqual({ kind: "ticket", base: "/jobs" })
  })

  it("asks for the state of the job it kept, again until it settles", () => {
    const asked = jobbed().find((step) => step.tool === "job-status")
    expect(argsOf(asked)).toEqual({ id: "${job}" })
    expect(asked?.want).toEqual({ kind: "state", state: "done" })
    expect(asked?.settle).toBeGreaterThan(1)
  })

  it("reads what the job wrote and then asks for it to stop", () => {
    const asked = jobbed().filter(
      (step) => step.tool === "job-output" || step.tool === "job-cancel"
    )
    expect(toolsOf(asked)).toEqual(["job-output", "job-cancel"])
    expect(argsOf(asked[0])).toEqual({ id: "${job}" })
    expect(asked[0]?.want).toEqual({ kind: "state", state: "done" })
    expect(asked[1]?.want).toEqual({ kind: "absent", code: "conflict" })
  })
})

describe("the driver that walks the surface through its steps", () => {
  const asked: ReadonlyArray<Step> = [
    { tool: "capabilities", args: {}, want: { kind: "types", types: ["Patient"] } }
  ]

  it("asks every step it was given and reports nothing when each one holds", async () => {
    const call = async () => ({
      kind: "answered" as const,
      isError: false,
      body: { resourceTypes: ["Patient"] }
    })
    expect(await drive(asked, call)).toEqual([])
  })

  it("names the tool and the field an answer got wrong", async () => {
    const call = async () => ({
      kind: "answered" as const,
      isError: false,
      body: { resourceTypes: [] }
    })
    expect(await drive(asked, call)).toEqual([
      'capabilities: resourceTypes: expected ["Patient"], got []'
    ])
  })

  it("names an answer that came back as an error when none was expected", async () => {
    const call = async () => ({
      kind: "answered" as const,
      isError: true,
      body: { resourceType: "OperationOutcome", issue: [{ code: "invalid" }] }
    })
    expect(await drive(asked, call)).toEqual([
      "capabilities: isError: expected false, got true",
      'capabilities: resourceTypes: expected ["Patient"], got []'
    ])
  })

  it("takes an answer it expected to be refused", async () => {
    const call = async () => ({
      kind: "answered" as const,
      isError: true,
      body: { resourceType: "OperationOutcome", issue: [{ code: "not-found" }] }
    })
    const steps: ReadonlyArray<Step> = [
      { tool: "read", args: { type: "Patient", id: "p1" }, want: { kind: "absent", code: "not-found" } }
    ]
    expect(await drive(steps, call)).toEqual([])
  })

  it("stops when the protocol refuses the tool", async () => {
    const call = async () => ({
      kind: "refused" as const,
      code: -32601,
      message: "no such tool"
    })
    await expect(drive(asked, call)).rejects.toThrow("capabilities was refused")
  })

  it("asks again until the answer it waits for arrives", async () => {
    let tried = 0
    const call = async () => {
      tried += 1
      return {
        kind: "answered" as const,
        isError: false,
        body: { state: tried < 3 ? "running" : "done" }
      }
    }
    const steps: ReadonlyArray<Step> = [
      { tool: "job-status", args: { id: "j1" }, want: { kind: "state", state: "done" }, settle: 5 }
    ]
    expect(await drive(steps, call, 0)).toEqual([])
    expect(tried).toBe(3)
  })

  it("reports the last answer when the tries it was given run out", async () => {
    let tried = 0
    const call = async () => {
      tried += 1
      return { kind: "answered" as const, isError: false, body: { state: "running" } }
    }
    const steps: ReadonlyArray<Step> = [
      { tool: "job-status", args: { id: "j1" }, want: { kind: "state", state: "done" }, settle: 2 }
    ]
    expect(await drive(steps, call, 0)).toEqual([
      'job-status: state: expected "done", got "running"'
    ])
    expect(tried).toBe(2)
  })

  it("keeps what a step answered and asks the next one with it", async () => {
    const seen: Array<unknown> = []
    const steps: ReadonlyArray<Step> = [
      {
        tool: "job-submit",
        args: { kind: "reindex", request: "{}" },
        want: { kind: "ticket", base: "/jobs" },
        keep: { name: "job", at: ["id"] }
      },
      {
        tool: "job-status",
        args: { id: "${job}", limit: 3 },
        want: { kind: "state", state: "done" }
      }
    ]
    const call = async (name: string, args: unknown) => {
      seen.push(args)
      return name === "job-submit"
        ? {
          kind: "answered" as const,
          isError: false,
          body: { id: "j9", location: "/jobs/j9", retryAfter: 5 }
        }
        : { kind: "answered" as const, isError: false, body: { state: "done" } }
    }
    expect(await drive(steps, call)).toEqual([])
    expect(seen[1]).toEqual({ id: "j9", limit: 3 })
  })

  it("leaves the name alone when the step it came from kept nothing", async () => {
    const seen: Array<unknown> = []
    const steps: ReadonlyArray<Step> = [
      {
        tool: "job-submit",
        args: { kind: "reindex", request: "{}" },
        want: { kind: "ticket", base: "/jobs" },
        keep: { name: "job", at: ["id"] }
      },
      { tool: "job-status", args: { id: "${job}" }, want: { kind: "state", state: "done" } }
    ]
    const call = async (name: string, args: unknown) => {
      seen.push(args)
      return name === "job-submit"
        ? { kind: "answered" as const, isError: false, body: { location: "/jobs/j9" } }
        : { kind: "answered" as const, isError: false, body: { state: "done" } }
    }
    await drive(steps, call)
    expect(seen[1]).toEqual({ id: "${job}" })
  })
})

describe("the field a step keeps from an answer", () => {
  it("takes the value at the path it was given", () => {
    expect(taken({ id: "j9" }, ["id"])).toBe("j9")
    expect(taken({ job: { id: "j9" } }, ["job", "id"])).toBe("j9")
    expect(taken({ done: 2 }, ["done"])).toBe("2")
  })

  it("answers nothing for a body that does not hold the path", () => {
    expect(taken({}, ["id"])).toBeUndefined()
    expect(taken({ id: "j9" }, ["id", "of"])).toBeUndefined()
    expect(taken("gone", ["id"])).toBeUndefined()
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
    expect(
      faults({ kind: "ticket", base: "/jobs" }, {
        id: "j9",
        location: "/jobs/j9",
        retryAfter: 5
      })
    ).toEqual([])
    expect(faults({ kind: "state", state: "done" }, { state: "done" })).toEqual([])
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
    expect(
      faults({ kind: "ticket", base: "/jobs" }, {
        id: "j9",
        location: "jobs/j9",
        retryAfter: 0
      })
    ).toEqual([
      'location: expected "/jobs/j9", got "jobs/j9"',
      'retryAfter: expected a positive number, got 0'
    ])
    expect(faults({ kind: "ticket", base: "/jobs" }, { location: "/jobs/" })).toEqual([
      'id: expected a job id, got undefined',
      'location: expected "/jobs/undefined", got "/jobs/"',
      'retryAfter: expected a positive number, got undefined'
    ])
    expect(faults({ kind: "state", state: "done" }, { state: "failed" })).toEqual([
      'state: expected "done", got "failed"'
    ])
  })

  it("reports an answer that is not a resource at all", () => {
    expect(faults({ kind: "types", types: ["Patient"] }, "gone")).toEqual([
      'resourceTypes: expected ["Patient"], got []'
    ])
  })
})
