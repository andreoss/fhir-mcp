import { Effect, Layer, ManagedRuntime } from "effect"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js"
import type { FhirEngine } from "../core/engine.js"
import { call, tools } from "../agent/tools.js"
import type { ToolSpec } from "../agent/tools.js"
import { Grant, callWrite, writeTools } from "../agent/write.js"
import type { Journal } from "../agent/write.js"
import type { Rules, Versions } from "../core/interactions.js"
import { PINNED_REVISION, capabilities, negotiate } from "./revision.js"

const writeNames = new Set(writeTools.map((tool) => tool.name))

export type Writes = Layer.Layer<Versions | Rules | Grant | Journal>

export const surface = (writable: boolean): ReadonlyArray<ToolSpec> =>
  writable ? [...tools, ...writeTools] : tools

export const build = (engine: Layer.Layer<FhirEngine>, writes?: Writes): Server => {
  const runtime = ManagedRuntime.make(engine)
  const writing = writes === undefined ? undefined : ManagedRuntime.make(writes)
  const offered = surface(writing !== undefined)
  const offeredNames = new Set(offered.map((tool) => tool.name))
  const server = new Server(
    { name: "fhir-mcp", version: "0.0.0" },
    { capabilities: capabilities() }
  )

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    negotiate(request.params.protocolVersion)
    return {
      protocolVersion: PINNED_REVISION,
      capabilities: capabilities(),
      serverInfo: { name: "fhir-mcp", version: "0.0.0" }
    }
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: offered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    if (!offeredNames.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`)
    }
    const args = request.params.arguments ?? {}
    const result = writeNames.has(name) && writing !== undefined
      ? await writing.runPromise(
          Effect.flatMap(Grant, (held) =>
            Effect.provideService(callWrite(name, args), Grant, {
              ...held,
              correlation: randomUUID()
            })
          )
        )
      : await runtime.runPromise(call(name, args))
    const content = [...result.content]
    if (result.elided !== undefined) {
      content.push({
        type: "text" as const,
        text: JSON.stringify({
          elided: { returned: result.elided.returned, of: result.elided.of }
        })
      })
    }
    return { content, isError: result.isError }
  })

  const close = server.close.bind(server)
  server.close = async () => {
    await close()
    await runtime.dispose()
    if (writing !== undefined) await writing.dispose()
  }

  return server
}

export const serveOverStdio = (
  engine: Layer.Layer<FhirEngine>,
  writes?: Writes
): Effect.Effect<Server, Error> =>
  Effect.tryPromise({
    try: async () => {
      const server = build(engine, writes)
      await server.connect(new StdioServerTransport())
      return server
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("transport refused"))
  })
