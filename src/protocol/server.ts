import { Effect, Layer, ManagedRuntime } from "effect"
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
import { PINNED_REVISION, capabilities, negotiate } from "./revision.js"

const known = new Set(tools.map((tool) => tool.name))

export const build = (engine: Layer.Layer<FhirEngine>): Server => {
  const runtime = ManagedRuntime.make(engine)
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
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    if (!known.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`)
    }
    const result = await runtime.runPromise(call(name, request.params.arguments ?? {}))
    return { content: [...result.content], isError: result.isError }
  })

  const close = server.close.bind(server)
  server.close = async () => {
    await close()
    await runtime.dispose()
  }

  return server
}

export const serveOverStdio = (engine: Layer.Layer<FhirEngine>): Effect.Effect<Server, Error> =>
  Effect.tryPromise({
    try: async () => {
      const server = build(engine)
      await server.connect(new StdioServerTransport())
      return server
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("transport refused"))
  })
