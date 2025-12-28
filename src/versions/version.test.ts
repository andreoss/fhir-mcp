import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import {
  compartmentIn,
  compartmentsOf,
  definitionIn,
  hasType,
  model,
  paramIn,
  paramsIn
} from "./version.js"
import { el } from "../model/shape.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const reason = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { readonly reason: string }).reason
  }
  throw new Error("expected a failure")
}

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { readonly _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const ONE = model({
  name: "1.2.3",
  elements: {
    Observation: { type: "Observation", elements: { status: el("code") } },
    Condition: { type: "Condition", elements: { code: el("code") } }
  },
  params: {
    Observation: { _id: { path: ["id"] }, status: { path: ["status"] } },
    Condition: { _id: { path: ["id"] } }
  },
  compartments: [
    {
      code: "patient",
      resource: "Patient",
      types: { Patient: { own: true, params: [] } }
    }
  ]
})

describe("a version model holds one release of the specification", () => {
  it("derives its type list from the element definitions it holds", () => {
    expect(ONE.types).toEqual(["Condition", "Observation"])
  })

  it("names the version it models", () => {
    expect(ONE.name).toBe("1.2.3")
  })

  it("answers whether it serves a type", () => {
    expect(hasType(ONE, "Observation")).toBe(true)
    expect(hasType(ONE, "Patient")).toBe(false)
  })
})

describe("a version model answers for the types it serves", () => {
  it("returns the element definition of a served type", async () => {
    expect((await run(definitionIn(ONE, "Observation"))).type).toBe(
      "Observation"
    )
  })

  it("refuses an unserved type, naming the version", async () => {
    const result = await exit(definitionIn(ONE, "Patient"))
    expect(tag(result)).toBe("Rejected")
    expect(reason(result)).toBe("Patient is not served in 1.2.3")
  })

  it("returns every declared search parameter of a served type", async () => {
    expect(Object.keys(await run(paramsIn(ONE, "Observation")))).toEqual([
      "_id",
      "status"
    ])
  })

  it("refuses the parameters of an unserved type, naming the version",
    async () => {
      expect(reason(await exit(paramsIn(ONE, "Patient")))).toBe(
        "Patient is not served in 1.2.3"
      )
    })
})

describe("a version model admits only its own search parameters", () => {
  it("admits a declared parameter", async () => {
    expect(await run(paramIn(ONE, "Observation", "status"))).toEqual({
      path: ["status"]
    })
  })

  it("refuses an undeclared parameter, naming the version", async () => {
    const result = await exit(paramIn(ONE, "Observation", "code"))
    expect(tag(result)).toBe("Rejected")
    expect(reason(result)).toBe(
      "code is not a search parameter of Observation in 1.2.3"
    )
  })

  it("refuses a parameter of an unserved type, naming the version",
    async () => {
      expect(reason(await exit(paramIn(ONE, "Patient", "family")))).toBe(
        "Patient is not served in 1.2.3"
      )
    })
})

describe("a version model carries its own compartment definitions", () => {
  it("returns a compartment by code", async () => {
    expect((await run(compartmentIn(ONE, "patient"))).resource).toBe("Patient")
  })

  it("refuses an unknown compartment, naming the version", async () => {
    const result = await exit(compartmentIn(ONE, "encounter"))
    expect(tag(result)).toBe("Rejected")
    expect(reason(result)).toBe("encounter is not a compartment in 1.2.3")
  })
})

describe("a version model names the compartments a type belongs to", () => {
  it("names the compartment that carries the type", () => {
    expect(compartmentsOf(ONE, "Patient")).toEqual(["patient"])
  })

  it("names none for a type no compartment carries", () => {
    expect(compartmentsOf(ONE, "Coding")).toEqual([])
  })
})
