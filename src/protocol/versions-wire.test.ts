import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { Catalog } from "../versions/port.js"
import { VERSIONS } from "../versions/catalog.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"

const unused: Engine = {
  read: () => Effect.die("unused"),
  search: () => Effect.die("unused"),
  resourceTypes: () => Effect.succeed([]),
  searchParameters: () => Effect.succeed([])
}

const empty: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, unused)

const catalog: Layer.Layer<Catalog> = Layer.succeed(Catalog, VERSIONS)

const dial = async () => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(empty, undefined, undefined, undefined, undefined, catalog)
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

const body = (called: unknown): Record<string, unknown> =>
  JSON.parse(((called as { content: ReadonlyArray<{ text: string }> }).content[0]?.text) ??
    "{}") as Record<string, unknown>

describe("VER-03 the versions a client can ask for over the wire", () => {
  it("lists the two version tools on the served surface", async () => {
    const { client, close } = await dial()
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toContain("versions")
    expect(listed.tools.map((tool) => tool.name)).toContain("version")
    await close()
  })

  it("answers the names of the served versions and the default", async () => {
    const { client, close } = await dial()
    const called = await client.callTool({ name: "versions", arguments: {} })
    expect(called.isError).toBeFalsy()
    expect(body(called)).toEqual({ versions: ["4.0.1", "5.0.0"], default: "4.0.1" })
    await close()
  })

  it("answers the types a named version carries", async () => {
    const { client, close } = await dial()
    const called = await client.callTool({ name: "version", arguments: { version: "5.0.0" } })
    expect(called.isError).toBeFalsy()
    const answered = body(called)
    expect(answered["version"]).toBe("5.0.0")
    expect(answered["types"]).toContain("Procedure")
    await close()
  })

  it("answers the elements and parameters of a type in a named version", async () => {
    const { client, close } = await dial()
    const called = await client.callTool({
      name: "version",
      arguments: { version: "4.0.1", type: "Patient" }
    })
    expect(called.isError).toBeFalsy()
    const answered = body(called)
    expect(answered["elements"]).toContain("gender")
    expect(answered["parameters"]).toContain("family")
    await close()
  })

  it("refuses a type the named version drops", async () => {
    const { client, close } = await dial()
    const called = await client.callTool({
      name: "version",
      arguments: { version: "5.0.0", type: "Encounter" }
    })
    expect(called.isError).toBe(true)
    expect(body(called)["resourceType"]).toBe("OperationOutcome")
    await close()
  })
})
