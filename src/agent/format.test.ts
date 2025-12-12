import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { FhirEngine } from "../core/engine.js"
import type { Engine, FhirResource, SearchQuery } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { call } from "./tools.js"
import { asResource, written } from "./format.js"

const patient: FhirResource = {
  resourceType: "Patient",
  id: "p1",
  gender: "female",
  name: [{ family: "Simpson", given: ["Marge"] }]
}

const found = {
  resourceType: "Bundle",
  type: "searchset",
  total: 1,
  entry: [{ resource: patient }]
}

const engine = (): Layer.Layer<FhirEngine> =>
  Layer.succeed(FhirEngine, {
    read: () => Effect.succeed(patient),
    search: (_query: SearchQuery) => Effect.succeed(found),
    resourceTypes: () => Effect.succeed(["Patient"]),
    searchParameters: () => Effect.succeed(["family"])
  } as Engine)

const answered = (name: string, args: unknown) =>
  Effect.runSync(call(name, args).pipe(Effect.provide(engine())))

const text = (name: string, args: unknown) => answered(name, args).content[0]!.text

const refused = (effect: Effect.Effect<unknown, Failure>): { readonly reason: string } => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    const error = exit.cause.error
    return { reason: error instanceof Rejected ? error.reason : String(error) }
  }
  throw new Error("expected a refusal")
}

describe("HOST-06 the representation a call is answered in", () => {
  it("writes json when asked, and by default", () => {
    expect(Effect.runSync(written(patient, "json"))).toBe(JSON.stringify(patient))
    expect(text("read", { type: "Patient", id: "p1" })).toBe(JSON.stringify(patient))
    expect(text("read", { type: "Patient", id: "p1", format: "json" })).toBe(
      JSON.stringify(patient)
    )
  })

  it("answers a read in xml when asked", () => {
    const document = text("read", { type: "Patient", id: "p1", format: "xml" })
    expect(document.startsWith("<Patient")).toBe(true)
    expect(document).toContain('<gender value="female"/>')
    expect(document).toContain('<family value="Simpson"/>')
  })

  it("answers a search in xml when asked", () => {
    const document = text("search", { type: "Patient", format: "xml" })
    expect(document.startsWith("<Bundle")).toBe(true)
    expect(document).toContain('<family value="Simpson"/>')
  })

  it("reads an xml document back into the resource it names", () => {
    const document = text("read", { type: "Patient", id: "p1", format: "xml" })
    const body = Effect.runSync(asResource(document, "xml"))
    expect(body.resourceType).toBe("Patient")
    expect(body["gender"]).toBe("female")
  })

  it("refuses a representation that is not served", () => {
    const result = answered("read", { type: "Patient", id: "p1", format: "ttl" })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("format")
  })

  it("refuses a body that does not match the format it declares", () => {
    expect(refused(asResource("<Patient/>", "json")).reason).toBe(
      "body: format json takes a resource object"
    )
    expect(refused(asResource({ resourceType: "Patient" }, "xml")).reason).toBe(
      "body: expected an xml document when format is xml"
    )
  })
})
