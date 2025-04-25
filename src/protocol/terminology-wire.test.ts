import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { TerminologyPort } from "../terminology/port.js"
import type { Terminology } from "../terminology/port.js"
import { layer } from "../terminology/terminology.js"
import type { Sources } from "../terminology/system.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"

const LOINC = "http://loinc.org"

const sources: Sources = {
  stored: [
    {
      url: LOINC,
      version: "2.74",
      content: "complete",
      concept: [
        { code: "1234-5", display: "Glucose [Mass/volume] in Serum", inactive: false }
      ]
    }
  ],
  unsupplied: []
}

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.succeed({ resourceType: "Patient", id: "p1" })
      : Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const unserved = Layer.succeed(TerminologyPort, {
  lookup: () => Effect.fail(new NotFound({ type: "CodeSystem", id: LOINC })),
  subsumes: () => Effect.succeed("unknown" as const),
  compare: () => Effect.succeed({ _tag: "Text", equal: false, reason: "unserved" }),
  expand: () => Effect.fail(new NotFound({ type: "ValueSet", id: "none" }))
} satisfies Terminology)

const dial = async (terms?: Layer.Layer<TerminologyPort>) => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine, undefined, undefined, terms)
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

describe("AGT-16 terminology on the served surface", () => {
  it("offers lookup only when the build carries a terminology source", async () => {
    const without = await dial()
    expect((await without.client.listTools()).tools.map((one) => one.name)).not.toContain("lookup")
    await without.close()
    const withTerms = await dial(layer(sources))
    expect((await withTerms.client.listTools()).tools.map((one) => one.name)).toContain("lookup")
    await withTerms.close()
  })

  it("resolves a code through the port over the wire", async () => {
    const { client, close } = await dial(layer(sources))
    const called = await client.callTool({
      name: "lookup",
      arguments: { system: LOINC, code: "1234-5" }
    })
    expect(called.isError).toBe(false)
    const text = (called.content as ReadonlyArray<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("Glucose")
    await close()
  })

  it("answers a code it does not carry as an outcome, not a crash", async () => {
    const { client, close } = await dial(unserved)
    const called = await client.callTool({
      name: "lookup",
      arguments: { system: LOINC, code: "0-0" }
    })
    expect(called.isError).toBe(true)
    const text = (called.content as ReadonlyArray<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("OperationOutcome")
    await close()
  })
})