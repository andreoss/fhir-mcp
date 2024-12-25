import { Effect } from "effect"
import { tools } from "../agent/tools.js"
import type { ToolSpec } from "../agent/tools.js"
import { NotFound } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export const OPERATION_PREFIX = "op_"

export interface OperationParameter {
  readonly name: string
  readonly use: "in"
  readonly min: number
  readonly max: string
  readonly type: string
}

export interface OperationDefinition {
  readonly resourceType: "OperationDefinition"
  readonly status: "active"
  readonly kind: "operation"
  readonly name: string
  readonly code: string
  readonly description: string
  readonly affectsState: boolean
  readonly system: boolean
  readonly type: boolean
  readonly instance: boolean
  readonly parameter: ReadonlyArray<OperationParameter>
}

const typeOf = (schema: unknown): string => {
  const declared =
    typeof schema === "object" && schema !== null
      ? (schema as { readonly type?: unknown }).type
      : undefined
  switch (declared) {
    case "integer":
      return "integer"
    case "number":
      return "decimal"
    case "boolean":
      return "boolean"
    default:
      return "string"
  }
}

const parametersOf = (spec: ToolSpec): ReadonlyArray<OperationParameter> =>
  Object.entries(spec.inputSchema.properties).map(([name, schema]) => ({
    name,
    use: "in",
    min: spec.inputSchema.required.includes(name) ? 1 : 0,
    max: "1",
    type: typeOf(schema)
  }))

const definitionOf = (spec: ToolSpec): OperationDefinition => {
  const accepted = Object.keys(spec.inputSchema.properties)
  const code = spec.name.slice(OPERATION_PREFIX.length)
  const instance = accepted.includes("id")
  const type = accepted.includes("type")
  return {
    resourceType: "OperationDefinition",
    status: "active",
    kind: "operation",
    name: code,
    code,
    description: spec.description,
    affectsState: !spec.annotations.readOnlyHint,
    system: !instance && !type,
    type,
    instance,
    parameter: parametersOf(spec)
  }
}

export const definitions = (
  specs: ReadonlyArray<ToolSpec> = tools
): ReadonlyArray<OperationDefinition> =>
  specs.filter((spec) => spec.name.startsWith(OPERATION_PREFIX)).map(definitionOf)

export const lookup = (
  code: string,
  specs: ReadonlyArray<ToolSpec> = tools
): Effect.Effect<OperationDefinition, Failure> => {
  const found = definitions(specs).find((definition) => definition.code === code)
  return found === undefined
    ? Effect.fail(new NotFound({ type: "OperationDefinition", id: code }))
    : Effect.succeed(found)
}
