import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { InitializeResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { open } from "../jobs/queue.js"
import { Jobs, desk } from "../jobs/service.js"
import { registry } from "../jobs/types.js"
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

const kinds = registry({
  reindex: {
    split: (request) => Effect.succeed(request.split(",")),
    run: () => Effect.void
  }
})

const deskOn: Layer.Layer<Jobs> = Layer.scoped(
  Jobs,
  Effect.orDie(Effect.map(open(":memory:"), (queue) => desk(queue, kinds)))
)

const dial = async (jobs?: Layer.Layer<Jobs>) => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = build(engine, undefined, undefined, undefined, jobs)
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
    found.push(...page.tools.map((tool) => tool.name))
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return found
}

const body = (called: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
  JSON.parse((called.content as ReadonlyArray<{ text: string }>)[0]?.text ?? "{}") as Record<
    string,
    unknown
  >

describe("JOB-02 the job desk on the served surface", () => {
  it("serves the job tools only when the build carries a desk", async () => {
    const without = await dial()
    expect(await named(without.client)).not.toContain("job-submit")
    await without.close()
    const withJobs = await dial(deskOn)
    const offered = await named(withJobs.client)
    expect(offered).toContain("job-submit")
    expect(offered).toContain("job-status")
    expect(offered).toContain("job-cancel")
    await withJobs.close()
  })

  it("submits, polls and cancels a job over the wire", async () => {
    const { client, close } = await dial(deskOn)
    const submitted = await client.callTool({
      name: "job-submit",
      arguments: { kind: "reindex", request: "a,b" }
    })
    expect(submitted.isError).toBe(false)
    const ticket = body(submitted)
    const id = String(ticket["id"])
    expect(ticket["location"]).toBe(`/jobs/${id}`)
    expect(ticket["retryAfter"]).toBeGreaterThan(0)

    const polled = await client.callTool({ name: "job-status", arguments: { id } })
    expect(polled.isError).toBe(false)
    expect(body(polled)["id"]).toBe(id)
    expect(body(polled)["total"]).toBe(2)

    const cancelled = await client.callTool({ name: "job-cancel", arguments: { id } })
    expect(cancelled.isError).toBe(false)
    expect(body(cancelled)["state"]).toBe("cancelled")
    await close()
  })

  it("refuses a kind the desk does not carry over the wire", async () => {
    const { client, close } = await dial(deskOn)
    const called = await client.callTool({
      name: "job-submit",
      arguments: { kind: "export", request: "{}" }
    })
    expect(called.isError).toBe(true)
    expect(body(called)["resourceType"]).toBe("OperationOutcome")
    await close()
  })
})
