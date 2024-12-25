import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { tools } from "../agent/tools.js"
import type { ToolSpec } from "../agent/tools.js"
import { statusOf, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { OPERATION_PREFIX, definitions, lookup } from "./operations.js"

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const failure = <A>(exit: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected failure")
}

const spec = (
  name: string,
  properties: Record<string, unknown>,
  required: ReadonlyArray<string>,
  readOnlyHint = true
): ToolSpec => ({
  name,
  description: "an extended operation this build has grown",
  inputSchema: { type: "object", properties, required },
  annotations: {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: readOnlyHint,
    openWorldHint: false
  }
})

const instanceOp = spec(
  `${OPERATION_PREFIX}everything`,
  {
    type: { type: "string" },
    id: { type: "string" },
    count: { type: "integer" },
    weight: { type: "number" },
    active: { type: "boolean" },
    filter: {}
  },
  ["type", "id"]
)

const systemOp = spec(`${OPERATION_PREFIX}reindex`, {}, [], false)

describe("operation definitions", () => {
  it("serves no extended operation, because no tool provides one", () => {
    expect(definitions()).toEqual([])
    for (const tool of tools) {
      expect(tool.name.startsWith(OPERATION_PREFIX)).toBe(false)
    }
  })

  it("answers not-found for any operation asked of this build", () => {
    const error = failure(Effect.runSyncExit(lookup("everything")))
    expect(statusOf(error)).toBe(404)
    expect(toOutcome(error).issue[0]?.code).toBe("not-found")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("everything")
  })

  it("defines an operation once a tool provides it", () => {
    const defined = definitions([...tools, instanceOp])
    expect(defined).toHaveLength(1)
    const only = defined[0]
    expect(only?.resourceType).toBe("OperationDefinition")
    expect(only?.code).toBe("everything")
    expect(only?.name).toBe("everything")
    expect(only?.status).toBe("active")
    expect(only?.kind).toBe("operation")
    expect(only?.description).toBe(instanceOp.description)
  })

  it("takes the level it is called at from the arguments it accepts", () => {
    const instance = definitions([instanceOp])[0]
    expect(instance?.instance).toBe(true)
    expect(instance?.type).toBe(true)
    expect(instance?.system).toBe(false)
    const system = definitions([systemOp])[0]
    expect(system?.instance).toBe(false)
    expect(system?.type).toBe(false)
    expect(system?.system).toBe(true)
  })

  it("takes whether it affects state from the annotation", () => {
    expect(definitions([instanceOp])[0]?.affectsState).toBe(false)
    expect(definitions([systemOp])[0]?.affectsState).toBe(true)
  })

  it("takes its parameters from the input schema", () => {
    const parameter = definitions([instanceOp])[0]?.parameter ?? []
    expect(parameter.map((p) => p.name)).toEqual([
      "type",
      "id",
      "count",
      "weight",
      "active",
      "filter"
    ])
    expect(parameter.every((p) => p.use === "in" && p.max === "1")).toBe(true)
    const required = parameter.filter((p) => p.min === 1)
    expect(required.map((p) => p.name)).toEqual(["type", "id"])
    expect(parameter.map((p) => p.type)).toEqual([
      "string",
      "string",
      "integer",
      "decimal",
      "boolean",
      "string"
    ])
  })

  it("falls back to a string for an argument that declares no type", () => {
    const odd = spec(`${OPERATION_PREFIX}odd`, { plain: null, bare: 1 }, [])
    expect(definitions([odd])[0]?.parameter.map((p) => p.type)).toEqual([
      "string",
      "string"
    ])
  })

  it("finds a defined operation by its code", () => {
    const found = value(Effect.runSyncExit(lookup("everything", [instanceOp])))
    expect(found.code).toBe("everything")
  })

  it("still answers not-found for an operation no tool provides", () => {
    const exit = Effect.runSyncExit(lookup("export", [instanceOp]))
    expect(statusOf(failure(exit))).toBe(404)
  })
})
