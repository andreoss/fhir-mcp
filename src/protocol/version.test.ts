import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { PINNED_REVISION } from "./revision.js"
import { build } from "./server.js"
import { VERSION, probe } from "./version.js"

const packaged = (): string => {
  const file = readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  return String((JSON.parse(file) as { version: string }).version)
}

const dockerfile = (): string =>
  readFileSync(new URL("../../docker/Dockerfile", import.meta.url), "utf8")

const published = (): string =>
  readFileSync(new URL("../../docker/README.adoc", import.meta.url), "utf8")

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: () => Effect.fail(new NotFound({ type: "Patient", id: "none" })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed(["Patient"]),
  searchParameters: () => Effect.succeed(["family"])
} satisfies Engine)

describe("DEP-04 a build that knows its own version", () => {
  it("reads its version from the package it was built from", () => {
    expect(VERSION).toBe(packaged())
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("names itself and its version in a probe", () => {
    expect(probe()).toEqual({ name: "fhir-mcp", version: packaged() })
  })

  it("reports its own version when a client asks it to initialize", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair()
    const server = build(engine)
    const client = new Client({ name: "probe", version: "0" })
    await Promise.all([server.connect(b), client.connect(a)])
    const answer = await client.request(
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
    expect(answer.serverInfo.version).toBe(packaged())
    await client.close()
    await server.close()
  })

  it("states the version in the capability statement it hands out", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair()
    const server = build(engine)
    const client = new Client({ name: "probe", version: "0" })
    await Promise.all([server.connect(b), client.connect(a)])
    const called = await client.callTool({ name: "capabilities", arguments: {} })
    const parts = called.content as ReadonlyArray<{ text: string }>
    const body = JSON.parse(String(parts[0]?.text)) as {
      capabilityStatements: ReadonlyArray<{ software: { version: string } }>
    }
    expect(body.capabilityStatements[0]?.software.version).toBe(packaged())
    await client.close()
    await server.close()
  })
})

describe("DEP-04 the image that is published", () => {
  it("builds the compiled dist in one stage and runs it in another", () => {
    const stages = dockerfile()
      .split("\n")
      .filter((line) => line.startsWith("FROM "))
    expect(stages.length).toBeGreaterThan(1)
    expect(dockerfile()).toContain("npm run build")
    expect(dockerfile()).toContain("COPY --from=")
  })

  it("keeps the package beside the dist so the version resolves at run time", () => {
    expect(dockerfile()).toContain("package.json")
    expect(dockerfile()).toContain("dist")
  })

  it("states a version on the image it publishes", () => {
    expect(dockerfile()).toContain("org.opencontainers.image.version")
  })

  it("documents the scan and the publish of that image", () => {
    const text = published()
    expect(text).toContain("scan")
    expect(text).toContain("push")
    expect(text).toContain("VERSION")
  })
})
