import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { PINNED_REVISION } from "../protocol/revision.js"
import { statusOf, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { REGISTRIES, registryOf, versions } from "./versions.js"
import type { Registry } from "./versions.js"

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const failure = <A>(exit: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected failure")
}

const codes = (name: string): ReadonlyArray<string> =>
  versions().parameter.filter((p) => p.name === name).map((p) => p.valueCode)

const synthetic: Registry = {
  fhirVersion: "9.9.9",
  types: () => ["Zygote"],
  parametersOf: () => ({ _id: { path: ["id"] } })
}

describe("served versions", () => {
  it("names one version per registry the build actually loads", () => {
    expect(codes("version")).toEqual(REGISTRIES.map((r) => r.fhirVersion))
    expect(codes("version").length).toBeGreaterThan(0)
  })

  it("backs every named version with a registry that answers", () => {
    for (const code of codes("version")) {
      const registry = value(Effect.runSyncExit(registryOf(code)))
      expect(registry.fhirVersion).toBe(code)
      expect(registry.types().length).toBeGreaterThan(0)
      for (const type of registry.types()) {
        expect(registry.parametersOf(type)).toBeDefined()
      }
    }
  })

  it("defaults to the first registry", () => {
    expect(codes("default")).toEqual([REGISTRIES[0]?.fhirVersion])
  })

  it("reports the revision the protocol module pins", () => {
    expect(codes("protocol")).toEqual([PINNED_REVISION])
  })

  it("is a parameters resource", () => {
    expect(versions().resourceType).toBe("Parameters")
  })

  it("follows the registries it is given, naming nothing else", () => {
    const report = versions([synthetic])
    expect(report.parameter.filter((p) => p.name === "version")).toEqual([
      { name: "version", valueCode: "9.9.9" }
    ])
    expect(report.parameter.map((p) => p.valueCode)).not.toContain("4.0.1")
  })

  it("names no default when no registry is loaded", () => {
    expect(versions([]).parameter.map((p) => p.name)).not.toContain("default")
  })

  it("answers not-found for a version it does not serve", () => {
    const error = failure(Effect.runSyncExit(registryOf("3.0.2")))
    expect(statusOf(error)).toBe(404)
    expect(toOutcome(error).issue[0]?.code).toBe("not-found")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("3.0.2")
  })
})
