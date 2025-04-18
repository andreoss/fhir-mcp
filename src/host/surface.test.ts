import { describe, expect, it } from "vitest"
import { Effect } from "effect"
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
    const server = await Effect.runPromise(Effect.scoped(start(env)))
    const listed = await (server as unknown as {
      _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<{ tools: Array<{ name: string }> }>>
    })._requestHandlers.get("tools/list")!({ method: "tools/list", params: {} }, {})
    await server.close()
    return listed.tools.map((tool) => tool.name).sort()
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
