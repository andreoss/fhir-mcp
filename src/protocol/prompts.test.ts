import { describe, expect, it } from "vitest"
import type { ToolSpec } from "../agent/tools.js"
import type { Workflow } from "./prompts.js"
import { completeArgument, render, validate } from "./prompts.js"

const spec = (name: string, properties: Record<string, unknown>): ToolSpec => ({
  name,
  description: name,
  inputSchema: { type: "object", properties, required: [] },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  }
})

const served: ReadonlyArray<ToolSpec> = [
  spec("read", { type: {}, id: {}, max: {} }),
  spec("search", { type: {}, max: {}, parameters: {} }),
  spec("capabilities", { type: {} })
]

describe("protocol prompts", () => {
  it("asks only for arguments the served tools take", () => {
    const flaws = validate(served)
    const reasons = flaws.map((flaw) => flaw.reason)
    expect(reasons).toContain("tool not served: summarize")
    expect(reasons).not.toContain("argument not on read: type")
  })

  it("refuses to render a prompt that is not offered", () => {
    expect(render({ name: "nowhere-v1", args: {} })).toBeUndefined()
  })

  it("refuses to render a prompt missing a required argument", () => {
    expect(render({ name: "chart-review-v1", args: { type: "Patient" } })).toBeUndefined()
  })

  it("renders the script steps and the resolved arguments", () => {
    const rendered = render({ name: "chart-review-v1", args: { type: "Patient", id: "p1" } })
    expect(rendered).toBeDefined()
    expect(rendered?.[0]?.role).toBe("user")
    expect(rendered?.[0]?.content.text).toContain("read tool with type and id")
    expect(rendered?.[0]?.content.text).toContain("Arguments")
  })

  it("completes a type argument from the served types", () => {
    const values = completeArgument({
      name: "chart-review-v1",
      argument: "type",
      value: "Pa",
      tools: ["read"],
      types: ["Patient", "Observation"]
    })
    expect(values).toEqual(["Patient"])
  })

  it("completes tools from the served tool names", () => {
    const custom: ReadonlyArray<Workflow> = [
      {
        name: "pick-v1",
        description: "pick a tool",
        arguments: [{ name: "tool", description: "Tool to run.", domain: "tools" }],
        uses: [],
        script: []
      }
    ]
    const values = completeArgument(
      { name: "pick-v1", argument: "tool", value: "re", tools: ["read", "search"], types: [] },
      custom
    )
    expect(values).toEqual(["read"])
  })

  it("offers nothing for a prompt that is not offered", () => {
    expect(
      completeArgument({ name: "absent-v1", argument: "type", value: "", tools: [], types: ["Patient"] })
    ).toEqual([])
  })
})