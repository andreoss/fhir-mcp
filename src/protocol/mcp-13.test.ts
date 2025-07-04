import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  CreateMessageRequestSchema,
  InitializeResultSchema
} from "@modelcontextprotocol/sdk/types.js"
import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"

const BRIEF = "record-brief-v1"

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) =>
    type === "Patient" && id === "p1"
      ? Effect.succeed({ resourceType: "Patient", id: "p1" })
      : Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

interface Asked {
  count: number
  system: string | undefined
}

const dial = async (
  advertised: boolean,
  answer?: (system: string | undefined) => CreateMessageResult
) => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine)
  const client = new Client(
    { name: "probe", version: "0" },
    { capabilities: advertised ? { sampling: {} } : {} }
  )
  const asked: Asked = { count: 0, system: undefined }
  if (advertised && answer !== undefined) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      asked.count += 1
      asked.system = request.params.systemPrompt
      return answer(request.params.systemPrompt)
    })
  }
  await Promise.all([server.connect(b), client.connect(a)])
  await client.request(
    {
      method: "initialize",
      params: {
        protocolVersion: PINNED_REVISION,
        capabilities: advertised ? { sampling: {} } : {},
        clientInfo: { name: "probe", version: "0" }
      }
    },
    InitializeResultSchema
  )
  await client.notification({ method: "notifications/initialized" })
  return {
    asked,
    taken: (name: string = BRIEF, extra?: Record<string, string>) =>
      client.getPrompt({ name, arguments: { type: "Patient", id: "p1", ...extra } }),
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

const text = (content: unknown): string => {
  const part = content as { type: string; text?: string }
  return part.type === "text" ? (part.text ?? "") : ""
}

describe("MCP-13 sampling", () => {
  it("asks the client to draft when the client advertises sampling", async () => {
    const { asked, taken, close } = await dial(true, () => ({
      model: "probe-model",
      role: "assistant",
      content: { type: "text", text: "a brief of the record" },
      stopReason: "endTurn"
    }))
    const result = await taken()
    const drafted = result.messages.find((one) => one.role === "assistant")
    expect(text(drafted?.content)).toBe("a brief of the record")
    expect(asked.count).toBe(1)
    await close()
  })

  it("never asks when the client does not advertise sampling", async () => {
    const { asked, taken, close } = await dial(false)
    const result = await taken()
    expect(asked.count).toBe(0)
    expect(result.messages.every((one) => one.role === "user")).toBe(true)
    expect(result.messages.at(-1)?.content).toBeDefined()
    expect(text(result.messages.at(-1)?.content)).toContain("does not offer sampling")
    await close()
  })

  it("takes a refusal from the client as a normal outcome, not a failure", async () => {
    const { taken, close } = await dial(true, () => {
      throw new Error("the user declined")
    })
    const result = await taken()
    expect(result.messages.some((one) => one.role === "assistant")).toBe(false)
    expect(text(result.messages.at(-1)?.content)).toContain("refused")
    await close()
  })

  it("renders a prompt that does not sample without asking anyone", async () => {
    const { asked, taken, close } = await dial(true, () => ({
      model: "probe-model",
      role: "assistant",
      content: { type: "text", text: "unused" },
      stopReason: "endTurn"
    }))
    const result = await taken("chart-review-v1")
    expect(asked.count).toBe(0)
    expect(text(result.messages[0]?.content)).toContain("chart-review-v1 step 1")
    await close()
  })
})
