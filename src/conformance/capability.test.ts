import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { Effect, Exit } from "effect"
import { tools } from "../agent/tools.js"
import type { ToolSpec } from "../agent/tools.js"
import { parametersOf, types } from "../store/definitions.js"
import { statusOf } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { REGISTRIES } from "./versions.js"
import type { Registry } from "./versions.js"
import {
  paramType,
  providerOf,
  statement,
  statementFor,
  statements
} from "./capability.js"

const build = {
  software: { name: "server", version: "0.0.0" },
  date: "2025-01-01T00:00:00Z"
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const failure = <A>(exit: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected failure")
}

const registry = (): Registry => {
  const first = REGISTRIES[0]
  if (first === undefined) throw new Error("no registry loaded")
  return first
}

const rest = (specs: ReadonlyArray<ToolSpec> = tools) => {
  const only = statement(build, registry(), specs).rest[0]
  if (only === undefined) throw new Error("no rest")
  return only
}

const claimed = (specs: ReadonlyArray<ToolSpec> = tools): ReadonlyArray<string> => {
  const server = rest(specs)
  return [
    ...server.interaction.map((i) => i.code),
    ...server.resource.flatMap((r) => r.interaction.map((i) => i.code))
  ]
}

const spec = (name: string): ToolSpec => ({
  name,
  description: "an interaction this build has grown",
  inputSchema: { type: "object", properties: {}, required: [] },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  }
})

const invented: Registry = {
  fhirVersion: "9.9.9",
  types: () => ["Zygote"],
  parametersOf: () => ({ _id: { path: ["id"] }, colour: { path: ["colour"] } })
}

const source = readFileSync(new URL("./capability.ts", import.meta.url), "utf8")

describe("capability statement", () => {
  it("declares the system level of the running build", () => {
    const declared = statement(build, registry())
    expect(declared.resourceType).toBe("CapabilityStatement")
    expect(declared.status).toBe("active")
    expect(declared.kind).toBe("instance")
    expect(declared.date).toBe(build.date)
    expect(declared.software).toEqual(build.software)
    expect(declared.fhirVersion).toBe(registry().fhirVersion)
    expect(declared.rest[0]?.mode).toBe("server")
  })

  it("claims only the format this build answers in", () => {
    const format = statement(build, registry()).format
    expect(format).toEqual(["application/fhir+json"])
    expect(format.join()).not.toContain("xml")
  })

  it("carries one entry per declared type with exactly its parameters", () => {
    const served = rest().resource
    expect(served.map((r) => r.type)).toEqual([...types()])
    for (const entry of served) {
      const declared = Object.keys(parametersOf(entry.type) ?? {}).sort()
      expect(entry.searchParam.map((p) => p.name).sort()).toEqual(declared)
    }
  })

  it("names no resource type of its own", () => {
    for (const type of types()) expect(source).not.toContain(type)
    for (const name of ["family", "given", "birthdate", "clinicalstatus"]) {
      expect(source).not.toContain(name)
    }
  })

  it("follows the registry it reads rather than a list of its own", () => {
    const server = statement(build, invented).rest[0]
    expect(server?.resource.map((r) => r.type)).toEqual(["Zygote"])
    const named = server?.resource[0]?.searchParam.map((p) => p.name)
    expect(named).toEqual(["_id", "colour"])
  })

  it("gives a type it knows nothing of no parameters at all", () => {
    const unknown: Registry = {
      fhirVersion: "0.0.0",
      types: () => ["Ghost"],
      parametersOf: () => undefined
    }
    expect(statement(build, unknown).rest[0]?.resource[0]?.searchParam).toEqual([])
  })

  it("types every search parameter from the path the definitions declare", () => {
    const patient = rest().resource.find((r) => r.type === types()[0])
    const typed = new Map(patient?.searchParam.map((p) => [p.name, p.type]))
    expect(typed.get("_id")).toBe("token")
    expect(typed.get("family")).toBe("string")
    expect(typed.get("birthdate")).toBe("date")
    expect(typed.get("identifier")).toBe("token")
  })

  it("classifies a parameter by its path", () => {
    expect(paramType(["subject", "reference"])).toBe("reference")
    expect(paramType(["identifier", "value"])).toBe("token")
    expect(paramType(["code", "coding", "code"])).toBe("token")
    expect(paramType(["birthDate"])).toBe("date")
    expect(paramType(["name", "family"])).toBe("string")
    expect(paramType([])).toBe("special")
  })

  it("claims no interaction that no tool provides", () => {
    const names = new Set(tools.map((tool) => tool.name))
    for (const code of claimed()) {
      const provider = providerOf(code)
      expect(provider).toBeDefined()
      expect(names.has(provider ?? "")).toBe(true)
    }
  })

  it("claims read and search, which the tools do provide", () => {
    expect(claimed()).toContain("read")
    expect(claimed()).toContain("search-type")
  })

  it("claims neither create nor update nor delete", () => {
    for (const code of ["create", "update", "delete", "patch", "vread"]) {
      expect(claimed()).not.toContain(code)
    }
  })

  it("claims an interaction only once a tool provides it", () => {
    expect(claimed([...tools, spec("create")])).toContain("create")
    expect(claimed([...tools, spec("transaction")])).toContain("transaction")
  })

  it("drops an interaction when its tool goes", () => {
    const without = tools.filter((tool) => tool.name !== "search")
    expect(claimed(without)).not.toContain("search-type")
    expect(claimed(without)).toContain("read")
  })

  it("gives one statement per loaded version", () => {
    expect(statements(build)).toHaveLength(REGISTRIES.length)
    expect(statements(build, [invented])[0]?.fhirVersion).toBe("9.9.9")
  })

  it("answers a request for a version it serves", () => {
    const found = value(Effect.runSyncExit(statementFor(build, registry().fhirVersion)))
    expect(found.fhirVersion).toBe(registry().fhirVersion)
  })

  it("answers not-found for a version it does not serve", () => {
    const exit = Effect.runSyncExit(statementFor(build, "3.0.2"))
    expect(statusOf(failure(exit))).toBe(404)
  })
})
