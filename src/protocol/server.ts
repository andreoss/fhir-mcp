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
import type { ToolResult, ToolSpec } from "../agent/tools.js"
import { Grant, callWrite, writeTools } from "../agent/write.js"
import type { Journal } from "../agent/write.js"
import { statements } from "../conformance/capability.js"
import { REGISTRIES, versions } from "../conformance/versions.js"
import type { Rules, Versions } from "../core/interactions.js"
import { edge } from "../obs/correlation.js"
import { Metrics } from "../obs/metrics.js"
import { PINNED_REVISION, capabilities, negotiate } from "./revision.js"
import { paginate } from "./cursor.js"

const writeNames = new Set(writeTools.map((tool) => tool.name))

const annotationsOf = (tool: ToolSpec) => {
  const destructive = tool.annotations.destructiveHint
  return {
    readOnlyHint: !destructive,
    destructiveHint: destructive,
    idempotentHint: tool.annotations.idempotentHint,
    openWorldHint: tool.annotations.openWorldHint
  }
}

const NAME = "fhir-mcp"

const VERSION = "0.0.0"

const REPORT = "capabilities"

export type Writes = Layer.Layer<Versions | Rules | Grant | Journal>

export type Observed = Layer.Layer<Metrics>

export const surface = (writable: boolean): ReadonlyArray<ToolSpec> =>
  writable ? [...tools, ...writeTools] : tools

const unmetered: Observed = Layer.succeed(Metrics, {
  record: () => Effect.void,
  time: (_op, _type, work) => work,
  snapshot: Effect.succeed([])
})

export const reported = (
  offered: ReadonlyArray<ToolSpec>,
  result: ToolResult,
  at: string
): ToolResult => {
  const first = result.content[0]
  if (result.isError || first === undefined) return result
  const body = JSON.parse(first.text) as Record<string, unknown>
  return {
    ...result,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...body,
          capabilityStatements: statements(
            { software: { name: NAME, version: VERSION }, date: at },
            REGISTRIES,
            offered
          ),
          versions: versions()
        })
      }
    ]
  }
}

export const build = (
  engine: Layer.Layer<FhirEngine>,
  writes?: Writes,
  observed: Observed = unmetered
): Server => {
  const runtime = ManagedRuntime.make(Layer.merge(engine, observed))
  const writing = writes === undefined ? undefined : ManagedRuntime.make(writes)
  const offered = surface(writing !== undefined)
  const offeredNames = new Set(offered.map((tool) => tool.name))
  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: capabilities() }
  )

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    negotiate(request.params.protocolVersion)
    return {
      protocolVersion: PINNED_REVISION,
      capabilities: capabilities(),
      serverInfo: { name: NAME, version: VERSION }
    }
  })

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const part = paginate(offered, request.params?.cursor, "tools")
    if (part === undefined) {
      throw new McpError(ErrorCode.InvalidParams, "tools cursor not accepted")
    }
    return {
      tools: part.page.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotationsOf(tool)
      })),
      ...(part.nextCursor === undefined ? {} : { nextCursor: part.nextCursor })
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    if (!offeredNames.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`)
    }
    const args = request.params.arguments ?? {}
    const correlation = randomUUID()
    const at = typeof args["type"] === "string" ? args["type"] : ""
    const answered = writeNames.has(name) && writing !== undefined
      ? await writing.runPromise(
          Effect.flatMap(Grant, (held) =>
            Effect.provideService(callWrite(name, args), Grant, {
              ...held,
              correlation
            })
          )
        )
      : await runtime.runPromise(
          edge(
            Effect.flatMap(Metrics, (meter) => meter.time(name, at, call(name, args))),
            correlation
          )
        )
    const result =
      name === REPORT ? reported(offered, answered, new Date().toISOString()) : answered
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
  writes?: Writes,
  observed?: Observed
): Effect.Effect<Server, Error> =>
  Effect.tryPromise({
    try: async () => {
      const server = build(engine, writes, observed)
      await server.connect(new StdioServerTransport())
      return server
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("transport refused"))
  })
