import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION, capabilities } from "./revision.js"
import { build } from "./server.js"

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.succeed({ resourceType: "Patient", id: "p1" })
      : Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const dial = async () => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine)
  const client = new Client({ name: "probe", version: "0" })
  await Promise.all([server.connect(b), client.connect(a)])
  await client.request(
    {
      method: "initialize",
      params: {
        protocolVersion: PINNED_REVISION,
        capabilities: {},
        clientInfo: { name: "probe", version: "0" }
      }
    },
    InitializeResultSchema
  )
  await client.notification({ method: "notifications/initialized" })
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe("MCP-11 prompts", () => {
  it("declares prompts and lists the named workflows", async () => {
    const { client, close } = await dial()
    expect(capabilities()["prompts"]).toBeDefined()
    const listed = await client.listPrompts()
    expect(listed.prompts.map((one) => one.name)).toContain("chart-review-v1")
    await close()
  })

  it("gets a workflow as messages once its arguments are given", async () => {
    const { client, close } = await dial()
    const got = await client.getPrompt({
      name: "chart-review-v1",
      arguments: { type: "Patient", id: "p1" }
    })
    expect(got.messages[0]?.role).toBe("user")
    expect(got.messages[0]?.content).toMatchObject({ type: "text" })
    expect(JSON.stringify(got.messages)).toContain("read tool with type and id")
    await close()
  })

  it("refuses a workflow whose required argument is missing", async () => {
    const { client, close } = await dial()
    const refused = await client
      .getPrompt({ name: "chart-review-v1", arguments: { type: "Patient" } })
      .catch((error: unknown) => error)
    expect((refused as { code?: unknown }).code).toBe(-32602)
    await close()
  })

  it("completes an argument from what the server serves", async () => {
    const { client, close } = await dial()
    const done = await client.complete({
      ref: { type: "ref/prompt", name: "chart-review-v1" },
      argument: { name: "type", value: "Pa" }
    })
    expect(done.completion.values).toEqual(["Patient"])
    await close()
  })
})