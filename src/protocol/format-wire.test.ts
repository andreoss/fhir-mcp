import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"

const patient = {
  resourceType: "Patient",
  id: "p1",
  gender: "female",
  name: [{ family: "Simpson" }]
}

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.succeed(patient)
      : Effect.fail(new NotFound({ type, id })),
  search: () =>
    Effect.succeed({
      resourceType: "Bundle",
      type: "searchset",
      total: 1,
      entry: [{ resource: patient }]
    }),
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

const asked = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = (await client.callTool({ name, arguments: args })) as {
    readonly content: ReadonlyArray<{ readonly text: string }>
    readonly isError?: boolean
  }
  return { text: answer.content[0]?.text ?? "", isError: answer.isError === true }
}

describe("HOST-06 the representation an answer is served in", () => {
  it("answers a read in xml when asked, and in json otherwise", async () => {
    const { client, close } = await dial()
    const xml = await asked(client, "read", { type: "Patient", id: "p1", format: "xml" })
    expect(xml.isError).toBe(false)
    expect(xml.text.startsWith("<Patient")).toBe(true)
    expect(xml.text).toContain('<family value="Simpson"/>')
    const json = await asked(client, "read", { type: "Patient", id: "p1" })
    expect(JSON.parse(json.text).name[0].family).toBe("Simpson")
    await close()
  })

  it("answers a search in xml when asked", async () => {
    const { client, close } = await dial()
    const xml = await asked(client, "search", { type: "Patient", format: "xml" })
    expect(xml.text.startsWith("<Bundle")).toBe(true)
    expect(xml.text).toContain('<gender value="female"/>')
    await close()
  })

  it("offers xml on the schema of the tools that read", async () => {
    const { client, close } = await dial()
    const page = await client.listTools()
    for (const name of ["read", "search"]) {
      const tool = page.tools.find((one) => one.name === name)
      expect(tool?.inputSchema.properties).toHaveProperty("format")
    }
    await close()
  })
})
