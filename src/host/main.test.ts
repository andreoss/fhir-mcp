import { describe, expect, it } from "vitest"
import { createServer } from "node:net"
import { Effect, Exit, Scope } from "effect"
import { start } from "./main.js"
import type { Running } from "./main.js"

const ORIGIN = "https://client.example"

const hosted = async (env: Record<string, string | undefined>) => {
  const scope = Effect.runSync(Scope.make())
  const running: Running = await Effect.runPromise(
    start(env).pipe(Effect.provideService(Scope.Scope, scope))
  )
  return {
    running,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

const free = async (): Promise<number> => {
  const probe = createServer()
  const port = await new Promise<number>((done) => {
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      done(typeof address === "object" && address !== null ? address.port : 0)
    })
  })
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

const exchange = async (running: Running) => {
  const endpoint = running.endpoint
  if (endpoint === undefined) throw new Error("no endpoint hosted")
  const url = `http://${endpoint.host}:${endpoint.port}${endpoint.path}`
  const answer = await fetch(url, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } }
    })
  })
  const body = (await answer.json()) as { result: { serverInfo: { name: string } } }
  return { url, session: answer.headers.get("mcp-session-id"), name: body.result.serverInfo.name }
}

const attempt = (env: Record<string, string | undefined>) =>
  Effect.runPromiseExit(Effect.scoped(start(env)))

const reason = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    return String((exit.cause.error as { message: string }).message)
  }
  throw new Error("expected a failure")
}

describe("composition root", () => {
  it("refuses to start on a configuration it cannot accept, saying why", async () => {
    expect(reason(await attempt({ FHIR_TRANSPORT: "pigeon" }))).toContain("FHIR_TRANSPORT")
  })

  it("refuses http without an origin allow list", async () => {
    expect(reason(await attempt({ FHIR_TRANSPORT: "http" }))).toContain("FHIR_HTTP_ORIGINS")
  })

  it("builds a running server over the transport it does serve", async () => {
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      const held = await hosted({ FHIR_TRANSPORT: "stdio" })
      expect(held.running.mode).toBe("stdio")
      expect(held.running.endpoint).toBeUndefined()
      await held.stop()
    } finally {
      process.stdout.write = original
    }
  })

  it("hosts the http transport on loopback and completes an exchange over it", async () => {
    const held = await hosted({
      FHIR_TRANSPORT: "http",
      FHIR_HTTP_ORIGINS: ORIGIN,
      FHIR_HTTP_PORT: String(await free())
    })
    expect(held.running.mode).toBe("http")
    expect(held.running.endpoint?.host).toBe("127.0.0.1")
    const did = await exchange(held.running)
    expect(did.name).toBe("fhir-mcp")
    expect(did.session).toBeTruthy()
    await held.stop()
  })

  it("closes the hosted transport when the scope it was started in closes", async () => {
    const held = await hosted({
      FHIR_TRANSPORT: "http",
      FHIR_HTTP_ORIGINS: ORIGIN,
      FHIR_HTTP_PORT: String(await free())
    })
    const { url } = await exchange(held.running)
    await held.stop()
    await expect(
      fetch(url, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      })
    ).rejects.toBeDefined()
  })
})
