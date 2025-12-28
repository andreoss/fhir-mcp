import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Catalog } from "../versions/port.js"
import { model } from "../versions/version.js"
import type { VersionModel } from "../versions/version.js"
import { el } from "../model/shape.js"
import { callVersion, versionTools } from "./versions.js"

const four = model({
  name: "4.0.1",
  elements: {
    Patient: { type: "Patient", elements: { gender: el("code"), name: el("string") } },
    Observation: { type: "Observation", elements: { status: el("code") } },
    Encounter: { type: "Encounter", elements: { status: el("code") } }
  },
  params: {
    Patient: { family: { path: ["name", "family"] } },
    Observation: { status: { path: ["status"] } }
  },
  compartments: []
})

const five = model({
  name: "5.0.0",
  elements: {
    Patient: { type: "Patient", elements: { gender: el("code") } }
  },
  params: { Patient: { family: { path: ["name", "family"] } } },
  compartments: [
    {
      code: "patient",
      resource: "Patient",
      types: {
        Patient: { own: true, params: [] },
        Observation: { own: false, params: ["subject"] }
      }
    }
  ]
})

const catalog: ReadonlyArray<VersionModel> = [four, five]

const layer: Layer.Layer<Catalog> = Layer.succeed(Catalog, catalog)

const call = (name: string, args: unknown = {}) =>
  Effect.runPromise(Effect.provide(callVersion(name, args), layer))

const body = (result: { content: ReadonlyArray<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>

describe("VER-01 the versions a build serves", () => {
  it("offers two read-only tools", () => {
    expect(versionTools.map((tool) => tool.name)).toEqual(["versions", "version"])
    expect(versionTools.every((tool) => tool.annotations.readOnlyHint)).toBe(true)
  })

  it("answers the names of the served versions and the default", async () => {
    const answered = await call("versions")
    expect(answered.isError).toBe(false)
    expect(body(answered)).toEqual({ versions: ["4.0.1", "5.0.0"], default: "4.0.1" })
  })

  it("refuses a tool it does not serve", async () => {
    const answered = await call("versioning")
    expect(answered.isError).toBe(true)
    expect(body(answered)["resourceType"]).toBe("OperationOutcome")
  })
})

describe("VER-02 what one version carries", () => {
  it("answers the types of a named version", async () => {
    const answered = await call("version", { version: "5.0.0" })
    expect(answered.isError).toBe(false)
    expect(body(answered)).toEqual({ version: "5.0.0", types: ["Patient"] })
  })

  it("answers the elements, parameters and compartments of a type", async () => {
    const answered = await call("version", { version: "4.0.1", type: "Patient" })
    expect(answered.isError).toBe(false)
    expect(body(answered)).toEqual({
      version: "4.0.1",
      type: "Patient",
      elements: ["gender", "name"],
      parameters: ["family"],
      compartments: []
    })
  })

  it("names the compartment a type belongs to in the later version", async () => {
    const answered = await call("version", { version: "5.0.0", type: "Patient" })
    expect(answered.isError).toBe(false)
    expect(body(answered)).toEqual({
      version: "5.0.0",
      type: "Patient",
      elements: ["gender"],
      parameters: ["family"],
      compartments: ["patient"]
    })
  })

  it("answers no parameter for a type the version indexes not at all", async () => {
    const answered = await call("version", { version: "4.0.1", type: "Encounter" })
    expect(answered.isError).toBe(false)
    expect(body(answered)).toEqual({
      version: "4.0.1",
      type: "Encounter",
      elements: ["status"],
      parameters: [],
      compartments: []
    })
  })

  it("names the typed difference between the two versions", async () => {
    const answered = await call("version", { version: "5.0.0", type: "Encounter" })
    expect(answered.isError).toBe(true)
  })

  it("refuses a version that is not served", async () => {
    const answered = await call("version", { version: "3.0.1" })
    expect(answered.isError).toBe(true)
    expect(body(answered)["resourceType"]).toBe("OperationOutcome")
  })

  it("refuses a type the version does not carry", async () => {
    const answered = await call("version", { version: "5.0.0", type: "Encounter" })
    expect(answered.isError).toBe(true)
    expect(body(answered)["resourceType"]).toBe("OperationOutcome")
  })

  it("refuses an empty version name", async () => {
    const answered = await call("version", { version: "" })
    expect(answered.isError).toBe(true)
  })
})

describe("VER-01 a build with no version at all", () => {
  it("answers no name and no default", async () => {
    const answered = await Effect.runPromise(
      Effect.provide(callVersion("versions", {}), Layer.succeed(Catalog, []))
    )
    expect(answered.isError).toBe(false)
    expect(body(answered)).toEqual({ versions: [], default: undefined })
  })
})
