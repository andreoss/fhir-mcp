import { Effect, Layer, ManagedRuntime } from "effect"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { TerminologyPort } from "../terminology/port.js"
import { call, tools } from "../agent/tools.js"
import type { ToolResult, ToolSpec } from "../agent/tools.js"
import { Grant, callWrite, writeTools } from "../agent/write.js"
import type { Journal } from "../agent/write.js"
import { bundleTools, callBundle } from "../agent/bundle.js"
import { Unit } from "../bundle/unit.js"
import { callJob, jobTools } from "../agent/jobs.js"
import { Jobs } from "../jobs/service.js"
import { DepotPort } from "../bulk/depot.js"
import { callTerminology, terminologyTools } from "../agent/terminology.js"
import { callVersion, versionTools } from "../agent/versions.js"
import { Catalog } from "../versions/port.js"
import { statements } from "../conformance/capability.js"
import { REGISTRIES, versions } from "../conformance/versions.js"
import type { Rules, Versions } from "../core/interactions.js"
import { edge } from "../obs/correlation.js"
import { Metrics } from "../obs/metrics.js"
import { PINNED_REVISION, capabilities, negotiate } from "./revision.js"
import { paginate } from "./cursor.js"
import { TEMPLATES, address, uriOf } from "./resources.js"
import type { ResourceEntry } from "./resources.js"
import { Session } from "./session.js"
import { briefed, draft } from "./sampling.js"
import { completeArgument, render, workflows } from "./prompts.js"
import { INSTRUCTIONS } from "./instructions.js"
import { NAME, VERSION } from "./version.js"

const writeNames = new Set(writeTools.map((tool) => tool.name))

const bundleNames = new Set(bundleTools.map((tool) => tool.name))

const jobNames = new Set(jobTools.map((tool) => tool.name))

const versionNames = new Set(versionTools.map((tool) => tool.name))

export const SERVED: ReadonlyArray<string> = [
  "tools",
  "resources",
  "prompts",
  "completions",
  "logging"
]

const annotationsOf = (tool: ToolSpec) => {
  const destructive = tool.annotations.destructiveHint
  return {
    readOnlyHint: !destructive,
    destructiveHint: destructive,
    idempotentHint: tool.annotations.idempotentHint,
    openWorldHint: tool.annotations.openWorldHint
  }
}

const REPORT = "capabilities"

export type Writes = Layer.Layer<Versions | Rules | Grant | Journal | Unit>

export type Observed = Layer.Layer<Metrics>

export type Desked = Layer.Layer<Jobs | DepotPort>

export type Catalogued = Layer.Layer<Catalog>

export const surface = (
  writable: boolean,
  withTerms = false,
  withJobs = false,
  withVersions = false
): ReadonlyArray<ToolSpec> => [
  ...tools,
  ...(withVersions ? versionTools : []),
  ...(withTerms ? terminologyTools : []),
  ...(withJobs ? jobTools : []),
  ...(writable ? [...writeTools, ...bundleTools] : [])
]

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
  observed: Observed = unmetered,
  terms?: Layer.Layer<TerminologyPort>,
  jobs?: Desked,
  catalog?: Catalogued
): Server => {
  const runtime = ManagedRuntime.make(Layer.merge(engine, observed))
  const writing = writes === undefined ? undefined : ManagedRuntime.make(writes)
  const terminology = terms === undefined ? undefined : ManagedRuntime.make(terms)
  const desk = jobs === undefined ? undefined : ManagedRuntime.make(jobs)
  const catalogue = catalog === undefined ? undefined : ManagedRuntime.make(catalog)
  const offered = surface(
    writing !== undefined,
    terminology !== undefined,
    desk !== undefined,
    catalogue !== undefined
  )
  const offeredNames = new Set(offered.map((tool) => tool.name))
  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: capabilities() }
  )

  const sessions = new Map<string, Session>()
  const own = (sessionId: string | undefined): Session => {
    const id = sessionId ?? ""
    const current = sessions.get(id)
    if (current !== undefined) return current
    const created = new Session()
    sessions.set(id, created)
    return created
  }
  const signatures = new Map<Session, string>()
  const resourceEntries = async (): Promise<ReadonlyArray<ResourceEntry>> => {
    const types = await runtime.runPromise(
      Effect.flatMap(FhirEngine, (held) => held.resourceTypes())
    )
    return [...types].sort().map((type) => ({
      uri: uriOf(type),
      name: `${type} resources`,
      description: "resources of one FHIR type",
      mimeType: "application/fhir+json"
    }))
  }

  const connect = server.connect.bind(server)
  server.connect = async (transport: Transport) => {
    if (transport.sessionId === undefined) transport.sessionId = randomUUID()
    return connect(transport)
  }

  server.setRequestHandler(InitializeRequestSchema, async (request, extra) => {
    negotiate(request.params.protocolVersion)
    own(extra.sessionId).adopt(request.params.capabilities)
    return {
      protocolVersion: PINNED_REVISION,
      capabilities: capabilities(),
      serverInfo: { name: NAME, version: VERSION },
      instructions: INSTRUCTIONS
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    if (!offeredNames.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`)
    }
    const args = request.params.arguments ?? {}
    const correlation = randomUUID()
    const at = typeof args["type"] === "string" ? args["type"] : ""
    const session = own(extra.sessionId)
    const token = request.params._meta?.progressToken
    const report = async (progress: number, message: string) => {
      if (token === undefined) return
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 2, message }
      })
    }
    await report(1, `${name} started`)
    if (session.canLog("info")) {
      await extra.sendNotification({
        method: "notifications/message",
        params: { level: "info", logger: NAME, data: { tool: name, correlation } }
      })
    }
    const lookup = terminology !== undefined && terminologyTools.some((tool) => tool.name === name)
    const named = catalogue !== undefined && versionNames.has(name)
    const onDesk = desk !== undefined && jobNames.has(name)
    const bundled = bundleNames.has(name) && writing !== undefined
    const answered = lookup
      ? await terminology.runPromise(callTerminology(name, args), { signal: extra.signal })
      : named
        ? await catalogue.runPromise(
            edge(callVersion(name, args), correlation),
            { signal: extra.signal }
          )
        : onDesk
        ? await desk.runPromise(edge(callJob(name, args), correlation), {
            signal: extra.signal
          })
        : bundled
          ? await writing.runPromise(
              Effect.flatMap(Grant, (held) =>
                Effect.provideService(callBundle(name, args), Grant, {
                  ...held,
                  correlation
                })
              ),
              { signal: extra.signal }
            )
          : writeNames.has(name) && writing !== undefined
      ? await writing.runPromise(
          Effect.flatMap(Grant, (held) =>
            Effect.provideService(callWrite(name, args), Grant, {
              ...held,
              correlation
            })
          ),
          { signal: extra.signal }
        )
      : await runtime.runPromise(
          edge(
            Effect.flatMap(Metrics, (meter) => meter.time(name, at, call(name, args))),
            correlation
          ),
          { signal: extra.signal }
        )
    await report(2, `${name} answered`)
    if (session.isCancelled(correlation)) {
      throw new McpError(ErrorCode.InternalError, `cancelled: ${name}`)
    }
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

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: workflows.map((one) => ({
      name: one.name,
      description: one.description,
      arguments: one.arguments.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required === true
      }))
    }))
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const given: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.params.arguments ?? {})) {
      if (typeof value === "string") given[key] = value
    }
    const name = request.params.name
    const rendered = render({ name, args: given })
    if (rendered === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `prompt not rendered: ${name}`)
    }
    const workflow = workflows.find((one) => one.name === name)
    if (workflow?.sampling === undefined) return { messages: rendered }
    const session = own(extra.sessionId)
    const outcome = await draft(
      workflow,
      given,
      session.sampling,
      (params) => server.createMessage(params)
    )
    return { messages: [...rendered, briefed(outcome)] }
  })

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const ref = request.params.ref
    const asked = request.params.argument
    if (ref.type !== "ref/prompt") return { completion: { values: [] } }
    const types = await runtime.runPromise(
      Effect.flatMap(FhirEngine, (held) => held.resourceTypes())
    )
    const values = completeArgument({
      name: ref.name,
      argument: asked.name,
      value: asked.value,
      tools: [...offeredNames],
      types: [...types]
    })
    return { completion: { values: [...values], total: values.length, hasMore: false } }
  })

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: workflows.map((one) => ({
      name: one.name,
      description: one.description,
      arguments: one.arguments.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required === true
      }))
    }))
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const given: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.params.arguments ?? {})) {
      if (typeof value === "string") given[key] = value
    }
    const name = request.params.name
    const found = workflows.find((one) => one.name === name)
    const rendered = render({ name, args: given })
    if (found === undefined || rendered === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `prompt not served: ${name}`)
    }
    const messages: Array<{
      readonly role: "user" | "assistant"
      readonly content: { readonly type: "text"; readonly text: string }
    }> = [...rendered]
    if (found.sampling !== undefined) {
      const session = own(extra.sessionId)
      const outcome = await draft(found, given, session.sampling, (params) =>
        server.createMessage(params)
      )
      messages.push(briefed(outcome))
    }
    return { messages }
  })

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const ref = request.params.ref
    const asked = request.params.argument
    if (ref.type !== "ref/prompt") return { completion: { values: [] } }
    const types = await runtime.runPromise(
      Effect.flatMap(FhirEngine, (held) => held.resourceTypes())
    )
    const values = completeArgument({
      name: ref.name,
      argument: asked.name,
      value: asked.value,
      tools: [...offeredNames],
      types: [...types]
    })
    return { completion: { values: [...values], total: values.length, hasMore: false } }
  })

  server.setRequestHandler(SetLevelRequestSchema, async (request, extra) => {
    own(extra.sessionId).setLogLevel(request.params.level)
    return {}
  })

  server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
    const session = own(extra.sessionId)
    const entries = await resourceEntries()
    const signature = entries.map((entry) => entry.uri).join("|")
    const prior = signatures.get(session)
    signatures.set(session, signature)
    if (prior !== undefined && prior !== signature && session.hasSubscriptions()) {
      await extra.sendNotification({ method: "notifications/resources/list_changed" })
    }
    const part = paginate(entries, request.params?.cursor, "resources")
    if (part === undefined) {
      throw new McpError(ErrorCode.InvalidParams, "resources cursor not accepted")
    }
    return {
      resources: part.page,
      ...(part.nextCursor === undefined ? {} : { nextCursor: part.nextCursor })
    }
  })

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: TEMPLATES
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    const at = address(uri)
    if (at === undefined || at.id === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `unreadable uri: ${uri}`)
    }
    const type = at.type
    const id = at.id
    try {
      const resource = await runtime.runPromise(
        edge(Effect.flatMap(FhirEngine, (held) => held.read(type, id)), randomUUID())
      )
      return {
        contents: [{ uri, mimeType: "application/fhir+json", text: JSON.stringify(resource) }]
      }
    } catch (cause) {
      throw new McpError(
        ErrorCode.InternalError,
        `read ${uri} failed: ${cause instanceof Error ? cause.message : "unknown cause"}`
      )
    }
  })

  server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    own(extra.sessionId).subscribe(request.params.uri)
    return {}
  })

  server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
    own(extra.sessionId).unsubscribe(request.params.uri)
    return {}
  })

  const close = server.close.bind(server)
  server.close = async () => {
    await close()
    await runtime.dispose()
    if (writing !== undefined) await writing.dispose()
    if (desk !== undefined) await desk.dispose()
    if (catalogue !== undefined) await catalogue.dispose()
  }

  return server
}

export const serveOverStdio = (
  engine: Layer.Layer<FhirEngine>,
  writes?: Writes,
  observed?: Observed,
  terms?: Layer.Layer<TerminologyPort>,
  jobs?: Desked,
  catalog?: Catalogued
): Effect.Effect<Server, Error> =>
  Effect.tryPromise({
    try: async () => {
      const server = build(engine, writes, observed, terms, jobs, catalog)
      await server.connect(new StdioServerTransport())
      return server
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("transport refused"))
  })
