import { afterAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { start } from "./main.js"

const quietly = async <A>(use: () => Promise<A>): Promise<A> => {
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return await use()
  } finally {
    process.stdout.write = original
  }
}

const offered = async (env: Record<string, string | undefined>) =>
  quietly(async () => {
    const started = await Effect.runPromise(Effect.scoped(start(env)))
    const server = started.server
    const list = (server as unknown as {
      _requestHandlers: Map<
        string,
        (r: unknown, e: unknown) => Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>
      >
    })._requestHandlers.get("tools/list")!
    const names: Array<string> = []
    let cursor: string | undefined
    do {
      const page = await list(
        { method: "tools/list", params: { ...(cursor === undefined ? {} : { cursor }) } },
        {}
      )
      names.push(...page.tools.map((tool) => tool.name))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    await server.close()
    return names.sort()
  })

describe("what the running server offers", () => {
  it("offers only read tools when writing is not granted", async () => {
    expect(await offered({ FHIR_TRANSPORT: "stdio" })).toEqual(["capabilities", "read", "search"])
  })

  it("offers the write tools when writing is granted", async () => {
    const names = await offered({ FHIR_TRANSPORT: "stdio", FHIR_ALLOW_WRITE: "true" })
    expect(names).toContain("create")
    expect(names).toContain("update")
    expect(names).toContain("delete")
    expect(names).toContain("patch")
    expect(names).toContain("read")
  })
})

const dir = mkdtempSync(join(tmpdir(), "host-"))

const store = join(dir, "state.duckdb")

const patients = [
  { resourceType: "Patient", id: "p1", name: [{ family: "Vance" }] },
  { resourceType: "Patient", id: "p2", name: [{ family: "Stone" }] }
]

const observations = ["p1", "p2"].map((who, at) => ({
  resourceType: "Observation",
  id: `o${at + 1}`,
  status: "final",
  code: { coding: [{ code: "8867-4" }] },
  subject: { reference: `Patient/${who}` }
}))

interface Answered {
  readonly content: ReadonlyArray<{ readonly text: string }>
  readonly isError: boolean
}

const called = async (
  server: unknown,
  name: string,
  args: unknown
): Promise<Record<string, unknown>> => {
  const handlers = (server as {
    _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<Answered>>
  })._requestHandlers
  const handle = handlers.get("tools/call")
  if (handle === undefined) throw new Error("no tool handler")
  const result = await handle(
    { method: "tools/call", params: { name, arguments: args } },
    {
      sessionId: "surface",
      sendNotification: async () => undefined,
      signal: new AbortController().signal
    }
  )
  return JSON.parse(String(result.content[0]?.text)) as Record<string, unknown>
}

const inSession = <A>(
  env: Record<string, string | undefined>,
  use: (server: unknown) => Promise<A>
): Promise<A> =>
  quietly(() =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(start(env), (running) =>
          Effect.promise(async () => {
            try {
              return await use(running.server)
            } finally {
              await running.server.close()
            }
          })
        )
      ) as Effect.Effect<A>
    )
  )

const found = (bundle: Record<string, unknown>): ReadonlyArray<string> =>
  ((bundle["entry"] ?? []) as ReadonlyArray<{ resource: { id: string } }>)
    .map((one) => one.resource.id)

describe("what the running server answers", () => {
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("answers a modifier and a chain the naive store cannot", async () => {
    const seen = await inSession(
      { FHIR_TRANSPORT: "stdio", FHIR_ALLOW_WRITE: "true", FHIR_STORE_PATH: store },
      async (server) => {
        for (const body of [...patients, ...observations]) {
          const made = await called(server, "create", { type: body.resourceType, body })
          if (made["resourceType"] === "OperationOutcome") throw new Error("create refused")
        }
        return {
          modifier: await called(server, "search", {
            type: "Patient",
            parameters: { "family:contains": "anc" }
          }),
          chain: await called(server, "search", {
            type: "Observation",
            parameters: { "subject:Patient.family": "Vance" }
          })
        }
      }
    )
    expect(found(seen.modifier)).toEqual(["p1"])
    expect(found(seen.chain)).toEqual(["o1"])
  }, 60000)

  it("keeps a resource outside the grant out of the answer", async () => {
    const seen = await inSession(
      {
        FHIR_TRANSPORT: "stdio",
        FHIR_STORE_PATH: store,
        FHIR_SCOPES: "patient:p1/*.read"
      },
      (server) => called(server, "search", { type: "Observation", parameters: {} })
    )
    expect(found(seen)).toEqual(["o1"])
  }, 60000)

  it("hands a caller the capability statement it derives from the surface", async () => {
    const seen = await inSession(
      { FHIR_TRANSPORT: "stdio", FHIR_STORE_PATH: store },
      (server) => called(server, "capabilities", {})
    )
    const declared = seen["capabilityStatements"] as ReadonlyArray<Record<string, unknown>>
    expect(declared[0]?.["resourceType"]).toBe("CapabilityStatement")
    expect(seen["resourceTypes"]).toContain("Observation")
  }, 60000)
})
