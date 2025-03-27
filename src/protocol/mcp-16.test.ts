import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { PINNED_REVISION } from "./revision.js"
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
  const greeted = await client.request(
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
  return {
    greeted,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe("MCP-16 instructions carried at initialize", () => {
  it("answers initialize with instructions a model can act on", async () => {
    const { greeted, close } = await dial()
    const instructions: unknown = greeted["instructions"]
    expect(typeof instructions).toBe("string")
    expect(instructions).toContain("capabilities")
    expect(instructions).toContain("Operating rules")
    await close()
  })

  it("carries the same instructions on every handshake", async () => {
    const first = await dial()
    const second = await dial()
    expect(first.greeted["instructions"]).toBe(second.greeted["instructions"])
    await first.close()
    await second.close()
  })
})