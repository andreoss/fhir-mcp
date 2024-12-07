import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.succeed({ resourceType: "Patient", id: "p1" })
      : Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", total: 0, entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const connected = async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = build(engine)
  const client = new Client({ name: "test", version: "0" })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return { client, close: async () => { await client.close(); await server.close() } }
}

describe("protocol server", () => {
  it("completes the lifecycle and agrees the pinned revision", async () => {
    const { client, close } = await connected()
    expect(client.getServerVersion()?.name).toBeTypeOf("string")
    expect(client.getServerCapabilities()?.tools).toBeDefined()
    await close()
  })

  it("lists the tools the surface declares", async () => {
    const { client, close } = await connected()
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["capabilities", "read", "search"])
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
    await close()
  })

  it("calls a tool and returns the resource", async () => {
    const { client, close } = await connected()
    const result = await client.callTool({ name: "read", arguments: { type: "Patient", id: "p1" } })
    expect(result.isError).toBe(false)
    const content = result.content as ReadonlyArray<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text).resourceType).toBe("Patient")
    await close()
  })

  it("returns a missing resource as a result, not a protocol error", async () => {
    const { client, close } = await connected()
    const result = await client.callTool({ name: "read", arguments: { type: "Patient", id: "gone" } })
    expect(result.isError).toBe(true)
    const content = result.content as ReadonlyArray<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text).issue[0].code).toBe("not-found")
    await close()
  })

  it("returns an unknown tool as a protocol error", async () => {
    const { client, close } = await connected()
    await expect(client.callTool({ name: "unheard_of", arguments: {} })).rejects.toThrow()
    await close()
  })

  it("serves the revision the documents pin", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const server = build(engine)
    const client = new Client({ name: "test", version: "0" })
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    expect(PINNED_REVISION).toBe("2025-03-26")
    await client.close()
    await server.close()
  })
})
