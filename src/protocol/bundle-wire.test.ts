import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { DuckDBInstance } from "@duckdb/node-api"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { Rules, Versions, defaults } from "../core/interactions.js"
import { Grant, Journal } from "../agent/write.js"
import type { Entry } from "../agent/audit.js"
import { Unit, unitOn } from "../bundle/unit.js"
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

const patient = (id: string) => ({
  resource: { resourceType: "Patient" as const, id, name: [{ family: "Simpson" }] },
  request: { method: "POST" as const, url: "Patient" }
})

const writesOn = async () => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const bound = await Effect.runPromise(unitOn(connection))
  return Layer.mergeAll(
    Layer.succeed(Versions, bound.store),
    Layer.succeed(Rules, defaults),
    Layer.succeed(Unit, bound.boundary),
    Layer.succeed(Grant, { write: true, correlation: "wire" }),
    Layer.succeed(Journal, { note: (_entry: Entry) => Effect.void })
  )
}

const dial = async (writes?: Awaited<ReturnType<typeof writesOn>>) => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine, writes)
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

const named = async (client: Client): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor })
    for (const tool of page.tools) found.push(tool.name)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return found
}

const asked = async (client: Client, name: string, entry: ReadonlyArray<unknown>) => {
  const answer = (await client.callTool({ name, arguments: { entry } })) as {
    readonly content: ReadonlyArray<{ readonly text: string }>
    readonly isError?: boolean
  }
  const body = JSON.parse(answer.content[0]?.text ?? "{}") as {
    readonly type?: string
    readonly entry?: ReadonlyArray<{ readonly response: { readonly status: string } }>
    readonly issue?: ReadonlyArray<{ readonly diagnostics: string }>
  }
  return { ...body, isError: answer.isError === true }
}

describe("BNDL bundle tools over the wire", () => {
  it("offers a transaction and a batch only when writes are served", async () => {
    const bare = await dial()
    const none = await named(bare.client)
    expect(none).not.toContain("transaction")
    expect(none).not.toContain("batch")
    await bare.close()
    const held = await dial(await writesOn())
    const some = await named(held.client)
    expect(some).toContain("transaction")
    expect(some).toContain("batch")
    await held.close()
  })

  it("applies a transaction of two writes", async () => {
    const held = await dial(await writesOn())
    const answer = await asked(held.client, "transaction", [patient("p1"), patient("p2")])
    expect(answer.isError).toBe(false)
    expect(answer.type).toBe("transaction-response")
    expect(answer.entry?.map((one) => one.response.status)).toEqual(["201", "201"])
    await held.close()
  })

  it("keeps nothing when one entry of a transaction fails", async () => {
    const held = await dial(await writesOn())
    const answer = await asked(held.client, "transaction", [
      patient("p1"),
      { request: { method: "POST", url: "Patient" } }
    ])
    expect(answer.isError).toBe(true)
    const after = await asked(held.client, "batch", [
      { request: { method: "GET", url: "Patient/p1" } }
    ])
    expect(after.entry?.map((one) => one.response.status)).toEqual(["404"])
    await held.close()
  })

  it("answers one outcome per entry of a batch", async () => {
    const held = await dial(await writesOn())
    const answer = await asked(held.client, "batch", [
      patient("p1"),
      { request: { method: "GET", url: "Patient/elsewhere" } }
    ])
    expect(answer.isError).toBe(false)
    expect(answer.type).toBe("batch-response")
    expect(answer.entry?.map((one) => one.response.status)).toEqual(["201", "404"])
    await held.close()
  })
})
