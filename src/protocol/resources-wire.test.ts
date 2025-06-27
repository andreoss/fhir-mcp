import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  ErrorCode,
  ResourceListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { build } from "./server.js"

const mutable: string[] = ["Patient"]

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.succeed({ resourceType: "Patient", id: "p1" })
      : Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed([...mutable]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const dial = async () => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine)
  let changed = 0
  const client = new Client({ name: "probe", version: "0" })
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    changed += 1
  })
  await Promise.all([server.connect(b), client.connect(a)])
  return {
    client,
    fires: () => changed,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

const readAs = async (client: Client, uri: string): Promise<Record<string, unknown>> => {
  const found = (await client.readResource({ uri })).contents[0]
  if (found === undefined || !("text" in found)) throw new Error(`no text content at ${uri}`)
  return JSON.parse(found.text) as Record<string, unknown>
}

describe("protocol resources", () => {
  it("lists one entry per served type under a stable fhir scheme", async () => {
    const { client, close } = await dial()
    const listed = await client.listResources()
    expect(listed.resources).toEqual([
      { uri: "fhir://Patient", name: "Patient resources", description: "resources of one FHIR type", mimeType: "application/fhir+json" }
    ])
    await close()
  })

  it("serves its read templates", async () => {
    const { client, close } = await dial()
    const templates = await client.listResourceTemplates()
    expect(templates.resourceTemplates.map((entry) => entry.uriTemplate)).toEqual([
      "fhir://{type}/{id}",
      "fhir://{type}/{id}/_history/{version}"
    ])
    await close()
  })

  it("reads a resource and its history-stable address over the wire", async () => {
    const { client, close } = await dial()
    expect((await readAs(client, "fhir://Patient/p1"))["resourceType"]).toBe("Patient")
    expect((await readAs(client, "fhir://Patient/p1/_history/1"))["resourceType"]).toBe("Patient")
    await close()
  })

  it("refuses a uri it cannot address", async () => {
    const { client, close } = await dial()
    const refused = await client.readResource({ uri: "https://example.com/Patient/p1" }).catch((error: unknown) => error)
    expect((refused as { code?: unknown }).code).toBe(ErrorCode.InvalidParams)
    await close()
  })

  it("keeps the subscribe round-trip wire-stable", async () => {
    const { client, close } = await dial()
    expect(await client.subscribeResource({ uri: "fhir://Patient" })).toEqual({})
    expect(await client.unsubscribeResource({ uri: "fhir://Patient" })).toEqual({})
    await close()
  })

  it("fires list-changed to a subscribed client when the served types change", async () => {
    const { client, fires, close } = await dial()
    expect(fires()).toBe(0)
    await client.subscribeResource({ uri: "fhir://Patient" })
    await client.listResources()
    mutable.push("Observation")
    await client.listResources()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fires()).toBe(1)
    mutable.pop()
    await client.listResources()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fires()).toBe(2)
    await close()
  })
})