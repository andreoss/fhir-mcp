import { describe, expect, it } from "vitest"
import { Deferred, Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  InitializeResultSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema
} from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION, capabilities } from "./revision.js"
import { build } from "./server.js"

const patient = { resourceType: "Patient", id: "p1" }

const held = { started: false, interrupted: false }

const gate = Effect.runSync(Deferred.make<void, never>())

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.onInterrupt(
          Effect.sync(() => {
            held.started = true
          }).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Effect.succeed(patient))
          ),
          () =>
            Effect.sync(() => {
              held.interrupted = true
            })
        )
      : Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

const dial = async () => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine)
  const client = new Client({ name: "probe", version: "0" })
  const logs: Array<string> = []
  const progress: Array<number> = []
  client.setNotificationHandler(LoggingMessageNotificationSchema, (note) => {
    logs.push(note.params.level)
  })
  client.setNotificationHandler(ProgressNotificationSchema, (note) => {
    progress.push(note.params.progress)
  })
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
    logs,
    progress,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe("MCP-12 utilities", () => {
  it("answers a ping", async () => {
    const { client, close } = await dial()
    await expect(client.ping()).resolves.toEqual({})
    await close()
  })

  it("declares logging and answers logging/setLevel", async () => {
    const { client, close } = await dial()
    expect(capabilities()["logging"]).toBeDefined()
    await expect(client.setLoggingLevel("error")).resolves.toEqual({})
    await close()
  })

  it("writes at the level the client set and not below it", async () => {
    const { client, logs, close } = await dial()
    await client.setLoggingLevel("error")
    await client.callTool({ name: "capabilities", arguments: {} })
    expect(logs).toEqual([])
    await client.setLoggingLevel("debug")
    await client.callTool({ name: "capabilities", arguments: {} })
    expect(logs.length).toBeGreaterThan(0)
    await close()
  })

  it("reports progress when the call carries a progress token", async () => {
    const { client, progress, close } = await dial()
    await client.callTool({
      name: "capabilities",
      arguments: {},
      _meta: { progressToken: "t1" }
    } as never)
    expect(progress).toEqual([1, 2])
    await close()
  })

  it("stops an in-flight call when the client cancels it", async () => {
    const { client, close } = await dial()
    const controller = new AbortController()
    const pending = client.callTool(
      { name: "read", arguments: { type: "Patient", id: "p1" } },
      undefined,
      { signal: controller.signal }
    )
    while (held.started === false) await new Promise((done) => setTimeout(done, 5))
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    await new Promise((done) => setTimeout(done, 50))
    expect(held.interrupted).toBe(true)
    await close()
  })
})