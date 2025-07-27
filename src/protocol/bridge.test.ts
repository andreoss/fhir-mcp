import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import type { Config } from "../config/config.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { serve } from "./http.js"
import type { Endpoint } from "./http.js"
import { NOREPLY_REASON, bridged } from "./bridge.js"
import { build } from "./server.js"

const ORIGIN = "https://client.example"

const config: Config = {
  transport: "http",
  http: { host: "127.0.0.1", port: 0, origins: [ORIGIN] },
  store: { path: ":memory:" },
  allowWrite: false,
  scopes: [],
  terminologyDir: undefined,
  logLevel: "info",
  trail: { path: ":memory:", key: "", retentionMs: 0 }
}

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: () => Effect.fail(new NotFound({ type: "Patient", id: "none" })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

interface Held {
  readonly endpoint: Endpoint
  readonly url: string
  close: () => Promise<void>
}

const started = async (): Promise<Held> => {
  const server = build(engine)
  const bridge = await Effect.runPromise(bridged(server))
  const endpoint = await Effect.runPromise(serve(config, bridge.handler))
  bridge.attach(endpoint)
  return {
    endpoint,
    url: `http://${endpoint.host}:${endpoint.port}${endpoint.path}`,
    close: async () => {
      await Effect.runPromise(endpoint.close)
      await server.close()
    }
  }
}

interface Answered {
  readonly body: Record<string, unknown>
  readonly session: string | undefined
}

const post = async (url: string, body: unknown, session?: string): Promise<Answered> => {
  const answer = await fetch(url, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(session === undefined ? {} : { "mcp-session-id": session })
    },
    body: JSON.stringify(body)
  })
  return {
    body: (await answer.json()) as Record<string, unknown>,
    session: answer.headers.get("mcp-session-id") ?? undefined
  }
}

describe("the bridge from the hosted transport to the server", () => {
  it("completes an initialize and a tools call over one session", async () => {
    const held = await started()
    const initialized = await post(held.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } }
    })
    const info = initialized.body["result"] as { serverInfo: { name: string } }
    expect(info.serverInfo.name).toBe("fhir-mcp")
    const session = initialized.session
    expect(session).toBeDefined()
    const listed = await post(
      held.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      session
    )
    const tools = (listed.body["result"] as { tools: ReadonlyArray<{ name: string }> }).tools
    expect(tools.map((one) => one.name)).toContain("read")
    await held.close()
  })

  it("takes a request the server makes of the client as a refusal, not a hang", async () => {
    const held = await started()
    const initialized = await post(held.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { sampling: {} },
        clientInfo: { name: "probe", version: "0" }
      }
    })
    const asked = await post(
      held.url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/get",
        params: { name: "record-brief-v1", arguments: { type: "Patient", id: "p1" } }
      },
      initialized.session
    )
    const got = asked.body["result"] as {
      messages: ReadonlyArray<{ content: { text: string } }>
    }
    expect(got.messages.at(-1)?.content.text).toContain(NOREPLY_REASON)
    await held.close()
  })

  it("hands a notification from the server to the session that asked for it", async () => {
    const held = await started()
    const initialized = await post(held.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } }
    })
    const session = initialized.session ?? ""
    const stream = await fetch(held.url, {
      headers: { origin: ORIGIN, accept: "text/event-stream", "mcp-session-id": session }
    })
    expect(stream.status).toBe(200)
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const read = stream.body?.getReader()
    await post(
      held.url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "capabilities", arguments: {} }
      },
      session
    )
    const frames: Array<string> = []
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !frames.some((one) => one.includes("notifications/message"))) {
      const next = read === undefined ? undefined : await read.read()
      if (next?.value === undefined) break
      frames.push(new TextDecoder().decode(next.value))
    }
    expect(frames.join("")).toContain("notifications/message")
    await read?.cancel()
    await held.close()
  })
})
