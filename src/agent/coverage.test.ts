import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, Engine } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import { paramsOf } from "../search/registry.js"
import { types } from "../store/definitions.js"
import { call } from "./tools.js"

const declared = types()

const declaredParametersOf = (type: string): ReadonlyArray<string> =>
  Object.keys(paramsOf(type) ?? {}).sort()

const seen: { pairs: ReadonlyArray<readonly [string, string]> } = { pairs: [] }

const empty: Bundle = { resourceType: "Bundle", type: "searchset", total: 0, entry: [] }

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    paramsOf(type) === undefined
      ? Effect.fail(new Rejected({ reason: `unsupported resource type: ${type}` }))
      : Effect.succeed({ resourceType: type, id }),
  search: (query) => {
    seen.pairs = query.parameters
    return paramsOf(query.type) === undefined
      ? Effect.fail(new Rejected({ reason: `unsupported resource type: ${query.type}` }))
      : Effect.succeed(empty)
  },
  resourceTypes: () => Effect.succeed(declared),
  searchParameters: (type) =>
    paramsOf(type) === undefined
      ? Effect.fail(new Rejected({ reason: `unsupported resource type: ${type}` }))
      : Effect.succeed(declaredParametersOf(type))
} satisfies Engine)

const run = (name: string, args: unknown) =>
  Effect.runSync(call(name, args).pipe(Effect.provide(engine)))

const body = (result: { content: ReadonlyArray<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>

const entryOf = (served: unknown, type: string): Record<string, unknown> | undefined =>
  (served as ReadonlyArray<Record<string, unknown>>).find((one) => one["type"] === type)

describe("AGT-10 the surface covers every served type and parameter", () => {
  it("declares more than a hand-written few types and parameters", () => {
    expect(declared.length).toBeGreaterThan(3)
    for (const type of declared) {
      expect(declaredParametersOf(type).length).toBeGreaterThan(0)
    }
  })

  it("answers capabilities for the whole served surface at once", () => {
    const answered = run("capabilities", {})
    expect(answered.isError).toBe(false)
    expect(body(answered)["resourceTypes"]).toEqual(declared)
    const served = body(answered)["served"]
    expect(Array.isArray(served)).toBe(true)
    for (const type of declared) {
      const entry = entryOf(served, type)
      expect(entry).toBeDefined()
      expect([...(entry?.["parameters"] as ReadonlyArray<string>)].sort()).toEqual(
        declaredParametersOf(type)
      )
    }
  })

  it("names the parameters the build declares for each type it is asked about", () => {
    for (const type of declared) {
      const answered = run("capabilities", { type })
      expect(answered.isError).toBe(false)
      expect([...(body(answered)["parameters"] as ReadonlyArray<string>)].sort()).toEqual(
        declaredParametersOf(type)
      )
    }
  })

  it("reads every served type", () => {
    for (const type of declared) {
      const answered = run("read", { type, id: "x1" })
      expect(answered.isError).toBe(false)
      expect(body(answered)["resourceType"]).toBe(type)
    }
  })

  it("searches every served type on every parameter it declares", () => {
    for (const type of declared) {
      for (const parameter of declaredParametersOf(type)) {
        const answered = run("search", { type, parameters: { [parameter]: "v1" } })
        expect(answered.isError).toBe(false)
        expect(seen.pairs).toEqual([[parameter, "v1"]])
      }
    }
  })

  it("searches every served type on a repeated parameter", () => {
    for (const type of declared) {
      const answered = run("search", {
        type,
        parameters: { _id: ["ge1", "le2"] }
      })
      expect(answered.isError).toBe(false)
      expect(seen.pairs).toEqual([
        ["_id", "ge1"],
        ["_id", "le2"]
      ])
    }
  })
})
