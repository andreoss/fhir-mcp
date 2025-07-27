import { describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { bodyOf, envOf, frame, open, parsed } from "./harness.js"

describe("harness framing", () => {
  it("frames a request as one line of newline delimited json rpc", () => {
    const line = frame(7, "tools/list", { cursor: "a" })
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line.trim())).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { cursor: "a" }
    })
  })

  it("frames a notification without an id", () => {
    const message = JSON.parse(frame(undefined, "notifications/initialized").trim())
    expect(message).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" })
  })

  it("reads back a framed object", () => {
    expect(parsed('{"jsonrpc":"2.0","id":1}')).toEqual({ jsonrpc: "2.0", id: 1 })
  })

  it("reports anything on the answer stream that is not an object", () => {
    expect(parsed("starting up")).toBeUndefined()
    expect(parsed("[1,2]")).toBeUndefined()
    expect(parsed("null")).toBeUndefined()
  })
})

describe("harness environment", () => {
  it("gives the server a store of its own and no ambient settings", () => {
    const env = envOf("/tmp/s.duckdb", true, {
      PATH: "/bin",
      HOME: "/home/a",
      FHIR_STORE_PATH: "/elsewhere",
      FHIR_HTTP_ORIGINS: "https://example.test"
    })
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/a",
      FHIR_TRANSPORT: "stdio",
      FHIR_STORE_PATH: "/tmp/s.duckdb",
      FHIR_ALLOW_WRITE: "true",
      FHIR_LOG_LEVEL: "error"
    })
  })

  it("asks for a read only surface when writing is not wanted", () => {
    expect(envOf("/tmp/s.duckdb", false, {})["FHIR_ALLOW_WRITE"]).toBe("false")
  })
})

describe("harness answers", () => {
  it("reads the resource an answer carries", () => {
    expect(bodyOf([{ type: "text", text: '{"resourceType":"Patient"}' }])).toEqual({
      resourceType: "Patient"
    })
  })

  it("keeps text that is not a resource as it stands", () => {
    expect(bodyOf([{ type: "text", text: "plain" }])).toBe("plain")
  })

  it("reports an answer that carries nothing", () => {
    expect(bodyOf([])).toBeUndefined()
  })
})

const HEAD = `let rest = ""
const answer = (id, body) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n")
process.stdin.on("data", (chunk) => {
  rest += chunk
  const lines = rest.split("\\n")
  rest = lines.pop()
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const asked = JSON.parse(line)
`

const GREETING = JSON.stringify({
  protocolVersion: "2025-03-26",
  capabilities: {},
  serverInfo: { name: "stand-in", version: "0" }
})

const noisy = `process.stdout.write("starting up\\n")
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n")
process.stderr.write("not a note\\n")
process.stderr.write(JSON.stringify({ tool: "none" }) + "\\n")
process.on("SIGTERM", () => {})
${HEAD}    if (asked.method === "initialize") answer(asked.id, { result: ${GREETING} })
    else if (asked.method === "tools/list") {
      process.stdout.write("noise again\\n")
      answer(asked.id, { result: {} })
    } else answer(asked.id, { result: {} })
  }
})
`

const REFUSAL = JSON.stringify({ code: -32600, message: "no thank you" })

const rude = `${HEAD}    answer(asked.id, { error: ${REFUSAL} })
  }
})
`

const mute = "process.stdin.resume()\n"

const hearing = `${HEAD}    if (asked.method === "initialize")
      answer(asked.id, {
        result: { ...${GREETING}, heard: process.env["FHIR_TERMINOLOGY_DIR"] ?? "none" }
      })
    else answer(asked.id, { result: {} })
  }
})
`

const stand = async (body: string): Promise<{ entry: string; store: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "fhir-suite-stand-"))
  const entry = join(dir, "stand.mjs")
  await writeFile(entry, body, "utf8")
  return { entry, store: join(dir, "state.duckdb") }
}

describe("harness sessions", () => {
  it("reports what a server puts on the answer stream that is not one", async () => {
    const { entry, store } = await stand(noisy)
    const session = await open({ entry, store })
    expect(session.greeting["protocolVersion"]).toBe("2025-03-26")
    expect(await session.listTools()).toEqual([])
    const called = await session.callTool("read", {})
    expect(called).toEqual({ kind: "answered", isError: false, body: undefined })
    expect(session.noise()).toEqual(["starting up", "noise again"])
    expect(session.notes()).toEqual([{ tool: "none" }])
    await session.close()
    await rm(dirname(entry), { recursive: true, force: true })
  }, 30000)

  it("says so when a server refuses to start a session", async () => {
    const { entry, store } = await stand(rude)
    await expect(open({ entry, store })).rejects.toThrow("no thank you")
    await rm(dirname(entry), { recursive: true, force: true })
  })

  it("hands a server the settings a caller names beside its own", async () => {
    const { entry, store } = await stand(hearing)
    const session = await open({ entry, store, env: { FHIR_TERMINOLOGY_DIR: "/terms" } })
    expect(session.greeting["heard"]).toBe("/terms")
    await session.close()
    await rm(dirname(entry), { recursive: true, force: true })
  }, 30000)

  it("names none of those settings when a caller names none", async () => {
    const { entry, store } = await stand(hearing)
    const session = await open({ entry, store })
    expect(session.greeting["heard"]).toBe("none")
    await session.close()
    await rm(dirname(entry), { recursive: true, force: true })
  }, 30000)

  it("bounds the wait for an answer that never comes", async () => {
    const { entry, store } = await stand(mute)
    await expect(open({ entry, store, budget: 200 })).rejects.toThrow(
      "no answer to initialize within 200ms"
    )
    await rm(dirname(entry), { recursive: true, force: true })
  })
})
