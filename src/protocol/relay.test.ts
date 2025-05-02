import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { Grant, Journal } from "../agent/write.js"
import type { Entry } from "../agent/audit.js"
import { Rules, Versions, defaults } from "../core/interactions.js"
import { build } from "./server.js"

const many = (n: number): Bundle => ({
  resourceType: "Bundle",
  type: "searchset",
  total: n,
  entry: Array.from({ length: n }, (_, i) => ({
    resource: { resourceType: "Patient", id: `p${i}` }
  }))
})

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) => Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed(many(50)),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const seen: Array<Entry> = []

const writes = Layer.mergeAll(
  Layer.succeed(Versions, {} as never),
  Layer.succeed(Rules, defaults),
  Layer.succeed(Grant, { write: false, correlation: "fixed-at-build" }),
  Layer.succeed(Journal, { note: (e: Entry) => Effect.sync(() => { seen.push(e) }) })
)

const connected = async (withWrites: boolean) => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine, withWrites ? writes : undefined)
  const client = new Client({ name: "probe", version: "0" })
  await Promise.all([server.connect(b), client.connect(a)])
  return { client, close: async () => { await client.close(); await server.close() } }
}

describe("what reaches the client", () => {
  it("states what a budgeted answer left out", async () => {
    const { client, close } = await connected(false)
    const result = await client.callTool({
      name: "search",
      arguments: { type: "Patient", max: 10 }
    })
    const parts = result.content as ReadonlyArray<{ type: string; text: string }>
    const said = parts.map((p) => JSON.parse(p.text)).find((v) => v.elided !== undefined)
    expect(said?.elided).toEqual({ returned: 10, of: 50 })
    await close()
  })

  it("says nothing about elision when nothing was left out", async () => {
    const { client, close } = await connected(false)
    const result = await client.callTool({
      name: "search",
      arguments: { type: "Patient", max: 1000 }
    })
    const parts = result.content as ReadonlyArray<{ type: string; text: string }>
    expect(parts.some((p) => p.text.includes("elided"))).toBe(false)
    await close()
  })

  it("gives every write call its own correlation", async () => {
    seen.length = 0
    const { client, close } = await connected(true)
    await client.callTool({ name: "create", arguments: { type: "Patient", body: { resourceType: "Patient", id: "p1" } } })
    await client.callTool({ name: "create", arguments: { type: "Patient", body: { resourceType: "Patient", id: "p2" } } })
    await close()
    const marks = seen.map((e) => e.correlation)
    expect(marks).toHaveLength(2)
    expect(marks[0]).not.toBe(marks[1])
    expect(marks[0]).not.toBe("fixed-at-build")
  })
})
