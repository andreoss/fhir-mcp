import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
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
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const dial = async () => {
  const [client, server] = InMemoryTransport.createLinkedPair()
  const served = build(engine)
  await served.connect(server)
  await client.start()
  const pending = new Map<string, (m: Record<string, unknown>) => void>()
  client.onmessage = (message) => {
    const m = message as Record<string, unknown>
    if (m["id"] !== undefined) pending.get(String(m["id"]))?.(m)
  }
  const ask = (id: number, method: string, params: unknown) => {
    const awaited = new Promise<Record<string, unknown>>((resolve) =>
      pending.set(String(id), resolve)
    )
    void client.send({ jsonrpc: "2.0", id, method, params } as never)
    return awaited
  }
  await ask(1, "initialize", {
    protocolVersion: PINNED_REVISION,
    capabilities: {},
    clientInfo: { name: "probe", version: "0" }
  })
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never)
  return {
    ask,
    close: async () => {
      await served.close()
      await client.close()
    }
  }
}

const outcome = (content: ReadonlyArray<{ readonly text: string }>): {
  readonly issue: ReadonlyArray<{ readonly code: string; readonly diagnostics?: string }>
} => JSON.parse(content[0]!.text) as never

describe("protocol tool errors", () => {
  it("answers an unknown tool with a protocol error, never a result", async () => {
    const wire = await dial()
    const answer = await wire.ask(2, "tools/call", { name: "unheard_of", arguments: {} })
    expect(answer["result"]).toBeUndefined()
    const error = answer["error"] as { readonly code: number }
    expect(error.code).toBe(-32602)
    await wire.close()
  })

  it("answers a missing resource as a result carrying the operation outcome", async () => {
    const wire = await dial()
    const answer = await wire.ask(2, "tools/call", {
      name: "read",
      arguments: { type: "Patient", id: "gone" }
    })
    expect(answer["error"]).toBeUndefined()
    const result = answer["result"] as {
      readonly isError: boolean
      readonly content: ReadonlyArray<{ readonly text: string }>
    }
    expect(result.isError).toBe(true)
    expect(outcome(result.content).issue[0]?.code).toBe("not-found")
    await wire.close()
  })

  it("answers invalid arguments as a result naming the outcome", async () => {
    const wire = await dial()
    const answer = await wire.ask(2, "tools/call", {
      name: "read",
      arguments: { type: "Patient" }
    })
    expect(answer["error"]).toBeUndefined()
    const result = answer["result"] as {
      readonly isError: boolean
      readonly content: ReadonlyArray<{ readonly text: string }>
    }
    expect(result.isError).toBe(true)
    expect(outcome(result.content).issue[0]?.code).toBe("invalid")
    expect(outcome(result.content).issue[0]?.diagnostics).toContain("id")
    await wire.close()
  })
})