import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) => Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed([]),
  searchParameters: () => Effect.succeed([])
} satisfies Engine)

const initializeWith = async (asked: string) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = build(engine)
  await server.connect(serverSide)
  const answer = new Promise<Record<string, unknown>>((resolve) => {
    clientSide.onmessage = (message) => resolve((message as { result: Record<string, unknown> }).result)
  })
  await clientSide.start()
  await clientSide.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: asked,
      capabilities: {},
      clientInfo: { name: "probe", version: "0" }
    }
  })
  const result = await answer
  await server.close()
  return result
}

describe("handshake", () => {
  it("answers the pinned revision when the client asks for it", async () => {
    const result = await initializeWith(PINNED_REVISION)
    expect(result["protocolVersion"]).toBe(PINNED_REVISION)
  })

  it("answers the pinned revision when the client asks for a later one", async () => {
    const result = await initializeWith(LATEST_PROTOCOL_VERSION)
    expect(result["protocolVersion"]).toBe(PINNED_REVISION)
    expect(result["protocolVersion"]).not.toBe(LATEST_PROTOCOL_VERSION)
  })

  it("answers the pinned revision when the client asks for an unknown one", async () => {
    const result = await initializeWith("1999-01-01")
    expect(result["protocolVersion"]).toBe(PINNED_REVISION)
  })

  it("declares its capabilities and names itself in the same answer", async () => {
    const result = await initializeWith(PINNED_REVISION)
    expect(result["capabilities"]).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: true, listChanged: true },
      logging: {}
    })
    expect((result["serverInfo"] as { name: string }).name).toBe("fhir-mcp")
  })
})
