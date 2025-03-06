import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { Rules, Versions, defaults } from "../core/interactions.js"
import { Grant, Journal } from "../agent/write.js"
import type { Entry } from "../agent/audit.js"
import { PAGE_SIZE } from "./cursor.js"
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

const writes = Layer.mergeAll(
  Layer.succeed(Versions, {} as never),
  Layer.succeed(Rules, defaults),
  Layer.succeed(Grant, { write: true, correlation: "test" }),
  Layer.succeed(Journal, { note: (_entry: Entry) => Effect.void })
)

const names = (tools: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> =>
  tools.map((tool) => tool.name)

const connected = async () => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine, writes)
  const client = new Client({ name: "probe", version: "0" })
  await Promise.all([server.connect(b), client.connect(a)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe("protocol tools", () => {
  it("pages the list by an opaque cursor, at most PAGE_SIZE per page", async () => {
    const { client, close } = await connected()
    const first = await client.listTools()
    expect(first.tools.length).toBeLessThanOrEqual(PAGE_SIZE)
    expect(first.nextCursor).toBeTypeOf("string")
    const second = await client.listTools({ cursor: first.nextCursor })
    expect(second.nextCursor).toBeUndefined()
    const all = [...names(first.tools), ...names(second.tools)]
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain("read")
    expect(all).toContain("delete")
    expect(all.sort()).toEqual(
      ["capabilities", "create", "delete", "patch", "read", "search", "update"].sort()
    )
    await close()
  })

  it("refuses a cursor that has been tampered with", async () => {
    const { client, close } = await connected()
    const first = await client.listTools()
    const cursor = first.nextCursor ?? ""
    const flipped = cursor[10] === "A" ? "B" : "A"
    const tampered = cursor.slice(0, 10) + flipped + cursor.slice(11)
    await expect(client.listTools({ cursor: tampered })).rejects.toThrow()
    await close()
  })

  it("declares annotations derived from the interaction, not hand-set", async () => {
    const { client, close } = await connected()
    const listed = await client.listTools()
    for (const tool of listed.tools) {
      const annotations = tool.annotations ?? {}
      if (["read", "search", "capabilities"].includes(tool.name)) {
        expect(annotations.readOnlyHint).toBe(true)
        expect(annotations.destructiveHint).toBe(false)
      }
      if (["create", "update", "delete", "patch"].includes(tool.name)) {
        expect(annotations.destructiveHint).toBe(true)
        expect(annotations.readOnlyHint).toBe(false)
      }
      expect(annotations.readOnlyHint).not.toBe(annotations.destructiveHint)
    }
    await close()
  })

  it("calls a tool by name and id over the wire", async () => {
    const { client, close } = await connected()
    const result = await client.callTool({
      name: "read",
      arguments: { type: "Patient", id: "p1" }
    })
    expect(result.isError).toBe(false)
    const content = result.content as ReadonlyArray<{ readonly type: string; readonly text: string }>
    expect(JSON.parse(content[0]!.text).resourceType).toBe("Patient")
    await close()
  })
})