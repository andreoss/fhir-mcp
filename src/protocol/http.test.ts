import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { Config } from "../config/config.js"
import { ENDPOINT, SECURITY_HEADERS, serve } from "./http.js"
import type { Endpoint, Handler, Incoming } from "./http.js"

const ORIGIN = "https://client.example"

const config = (
  origins: ReadonlyArray<string> = [ORIGIN],
  host = "127.0.0.1"
): Config => ({
  transport: "http",
  http: { host, port: 0, origins },
  store: { path: ":memory:" },
  allowWrite: false,
  scopes: [],
  terminologyDir: undefined,
  logLevel: "info",
  trail: { path: ":memory:", key: "", retentionMs: 0 }
})

const seen: Array<Incoming> = []

const handler: Handler = (message) => {
  seen.push(message)
  if (message.method === "boom") {
    return Effect.fail({ code: -32001, message: "refused" })
  }
  if (message.method === "die") return Effect.die(new Error("broken"))
  return Effect.succeed({ echo: message.method, session: message.session })
}

const live: Array<Endpoint> = []

const start = async (
  given: Config = config(),
  options?: { readonly deletable: boolean }
) => {
  const endpoint = await Effect.runPromise(serve(given, handler, options))
  live.push(endpoint)
  return {
    endpoint,
    url: `http://${endpoint.host}:${endpoint.port}${endpoint.path}`
  }
}

afterEach(async () => {
  seen.length = 0
  while (live.length > 0) {
    const endpoint = live.pop()
    if (endpoint !== undefined) await Effect.runPromise(endpoint.close)
  }
})

const post = (
  url: string,
  body: unknown,
  extra: Record<string, string> = {}
) =>
  fetch(url, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extra
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const init = async (url: string) => {
  const answer = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" }
  })
  const id = answer.headers.get("mcp-session-id")
  await answer.json()
  if (id === null) throw new Error("no session issued")
  return id
}

interface Event {
  readonly id: string
  readonly data: Record<string, unknown>
}

const listen = async (url: string, extra: Record<string, string> = {}) => {
  const control = new AbortController()
  const answer = await fetch(url, {
    headers: { origin: ORIGIN, accept: "text/event-stream", ...extra },
    signal: control.signal
  })
  const body = answer.body
  const reader = body === null ? undefined : body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<Event> => {
    for (;;) {
      const cut = buffer.indexOf("\n\n")
      if (cut >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const id = /^id: (.*)$/m.exec(frame)?.[1] ?? ""
        const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "{}"
        return { id, data: JSON.parse(data) as Record<string, unknown> }
      }
      if (reader === undefined) throw new Error("no stream")
      const chunk = await reader.read()
      if (chunk.done) throw new Error("stream ended")
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { answer, next, stop: () => control.abort() }
}

const settle = () => new Promise((done) => setTimeout(done, 25))

describe("streamable http transport", () => {
  it("answers post and get on one endpoint path", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { "mcp-session-id": session }
    )
    expect(answer.status).toBe(200)
    const stream = await listen(url, { "mcp-session-id": session })
    expect(stream.answer.status).toBe(200)
    expect(stream.answer.headers.get("content-type")).toContain(
      "text/event-stream"
    )
    stream.stop()
  })

  it("answers a path that is not the endpoint with 404", async () => {
    const { endpoint } = await start()
    const answer = await fetch(
      `http://${endpoint.host}:${endpoint.port}/elsewhere`,
      { headers: { origin: ORIGIN } }
    )
    expect(answer.status).toBe(404)
    expect(ENDPOINT).toBe("/mcp")
  })

  it("issues a random visible-ascii session id on initialize", async () => {
    const { url } = await start()
    const first = await init(url)
    const second = await init(url)
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(16)
    expect(/^[\x21-\x7e]+$/.test(first)).toBe(true)
  })

  it("answers a later request without a session id with 400", async () => {
    const { url } = await start()
    await init(url)
    const answer = await post(url, { jsonrpc: "2.0", id: 2, method: "ping" })
    expect(answer.status).toBe(400)
    const body = (await answer.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })

  it("answers an unknown session with 404 so the client restarts", async () => {
    const { url } = await start()
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { "mcp-session-id": "no-such-session" }
    )
    expect(answer.status).toBe(404)
  })

  it("ends a session on delete and answers 404 afterwards", async () => {
    const { url } = await start()
    const session = await init(url)
    const ended = await fetch(url, {
      method: "DELETE",
      headers: { origin: ORIGIN, "mcp-session-id": session }
    })
    expect(ended.status).toBe(204)
    const later = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { "mcp-session-id": session }
    )
    expect(later.status).toBe(404)
  })

  it("answers 405 when clients may not end sessions", async () => {
    const { url } = await start(config(), { deletable: false })
    const session = await init(url)
    const answer = await fetch(url, {
      method: "DELETE",
      headers: { origin: ORIGIN, "mcp-session-id": session }
    })
    expect(answer.status).toBe(405)
    expect(answer.headers.get("allow")).toContain("POST")
  })

  it("answers delete without a session id with 400", async () => {
    const { url } = await start()
    const answer = await fetch(url, {
      method: "DELETE",
      headers: { origin: ORIGIN }
    })
    expect(answer.status).toBe(400)
  })

  it("answers delete of an unknown session with 404", async () => {
    const { url } = await start()
    const answer = await fetch(url, {
      method: "DELETE",
      headers: { origin: ORIGIN, "mcp-session-id": "gone" }
    })
    expect(answer.status).toBe(404)
  })

  it("answers a session the server ended with 404", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    expect(await Effect.runPromise(endpoint.end(session))).toBe(true)
    expect(await Effect.runPromise(endpoint.end(session))).toBe(false)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { "mcp-session-id": session }
    )
    expect(answer.status).toBe(404)
  })

  it("answers a request with a single json body", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { "mcp-session-id": session }
    )
    expect(answer.headers.get("content-type")).toContain("application/json")
    const body = (await answer.json()) as {
      id: number
      result: { echo: string; session: string }
    }
    expect(body.id).toBe(7)
    expect(body.result.echo).toBe("ping")
    expect(body.result.session).toBe(session)
  })

  it("answers over a stream when only a stream is accepted", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 8, method: "ping" },
      { "mcp-session-id": session, accept: "text/event-stream" }
    )
    expect(answer.headers.get("content-type")).toContain("text/event-stream")
    const text = await answer.text()
    expect(text).toContain("id: ")
    expect(text).toContain("\"id\":8")
  })

  it("answers a notification with 202 and no body", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-session-id": session }
    )
    expect(answer.status).toBe(202)
    expect(await answer.text()).toBe("")
    expect(seen.some((m) => m.method === "notifications/initialized")).toBe(
      true
    )
  })

  it("accepts a client response with 202 and no handler call", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 4, result: {} },
      { "mcp-session-id": session }
    )
    expect(answer.status).toBe(202)
    expect(seen).toHaveLength(1)
  })

  it("carries a handler failure as a json-rpc error", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 9, method: "boom" },
      { "mcp-session-id": session }
    )
    const body = (await answer.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32001)
  })

  it("carries a broken handler as an internal error", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 10, method: "die" },
      { "mcp-session-id": session }
    )
    const body = (await answer.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32603)
  })

  it("refuses a body that is not json", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(url, "{oops", { "mcp-session-id": session })
    expect(answer.status).toBe(400)
    const body = (await answer.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32700)
  })

  it("refuses a body that is not a message", async () => {
    const { url } = await start()
    const session = await init(url)
    for (const body of ["42", "{\"jsonrpc\":\"1.0\",\"method\":\"a\"}"]) {
      const answer = await post(url, body, { "mcp-session-id": session })
      expect(answer.status).toBe(400)
    }
  })

  it("refuses a body beyond the accepted size", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(url, "x".repeat(1_200_000), {
      "mcp-session-id": session
    })
    expect(answer.status).toBe(413)
  })

  it("refuses a method the endpoint does not answer", async () => {
    const { url } = await start()
    const answer = await fetch(url, {
      method: "PUT",
      headers: { origin: ORIGIN }
    })
    expect(answer.status).toBe(405)
    expect(answer.headers.get("allow")).toContain("DELETE")
  })

  it("refuses a stream request that does not accept a stream", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await fetch(url, {
      headers: {
        origin: ORIGIN,
        accept: "application/json",
        "mcp-session-id": session
      }
    })
    expect(answer.status).toBe(406)
  })

  it("refuses a stream request without a session id", async () => {
    const { url } = await start()
    const answer = await fetch(url, {
      headers: { origin: ORIGIN, accept: "text/event-stream" }
    })
    expect(answer.status).toBe(400)
  })

  it("carries server messages on the stream a get opened", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    const stream = await listen(url, { "mcp-session-id": session })
    await settle()
    expect(
      await Effect.runPromise(
        endpoint.push(session, { jsonrpc: "2.0", method: "notifications/one" })
      )
    ).toBe(true)
    const event = await stream.next()
    expect(event.data["method"]).toBe("notifications/one")
    expect(event.id).not.toBe("")
    stream.stop()
  })

  it("reports a push with no listening stream", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    expect(await Effect.runPromise(endpoint.push(session, { a: 1 }))).toBe(
      false
    )
    expect(await Effect.runPromise(endpoint.push("absent", { a: 1 }))).toBe(
      false
    )
  })

  it("replays only what the reconnected stream missed", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    const stream = await listen(url, { "mcp-session-id": session })
    await settle()
    await Effect.runPromise(endpoint.push(session, { seq: "one" }))
    await Effect.runPromise(endpoint.push(session, { seq: "two" }))
    const first = await stream.next()
    const second = await stream.next()
    expect(first.data["seq"]).toBe("one")
    expect(second.data["seq"]).toBe("two")
    expect(first.id).not.toBe(second.id)
    stream.stop()
    await settle()
    const again = await listen(url, {
      "mcp-session-id": session,
      "last-event-id": first.id
    })
    const replayed = await again.next()
    expect(replayed.data["seq"]).toBe("two")
    expect(replayed.id).toBe(second.id)
    again.stop()
  })

  it("replays nothing that belonged to another stream", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    const stream = await listen(url, { "mcp-session-id": session })
    await settle()
    await Effect.runPromise(endpoint.push(session, { seq: "one" }))
    const first = await stream.next()
    const other = await post(
      url,
      { jsonrpc: "2.0", id: 11, method: "ping" },
      { "mcp-session-id": session, accept: "text/event-stream" }
    )
    const text = await other.text()
    expect(text).toContain("\"id\":11")
    stream.stop()
    await settle()
    const again = await listen(url, {
      "mcp-session-id": session,
      "last-event-id": first.id
    })
    await Effect.runPromise(endpoint.push(session, { seq: "later" }))
    const event = await again.next()
    expect(event.data["seq"]).toBe("later")
    expect(JSON.stringify(event.data)).not.toContain("11")
    again.stop()
  })

  it("opens a fresh stream when the last event id is unknown", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    const stream = await listen(url, {
      "mcp-session-id": session,
      "last-event-id": "elsewhere-4"
    })
    await settle()
    await Effect.runPromise(endpoint.push(session, { seq: "fresh" }))
    const event = await stream.next()
    expect(event.data["seq"]).toBe("fresh")
    stream.stop()
  })

  it("answers a batch as a batch with one result per request", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      [
        { jsonrpc: "2.0", id: 1, method: "a" },
        { jsonrpc: "2.0", id: 2, method: "b" },
        { jsonrpc: "2.0", id: 3, method: "c" }
      ],
      { "mcp-session-id": session }
    )
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as Array<{ id: number }>
    expect(body).toHaveLength(3)
    expect(body.map((entry) => entry.id)).toEqual([1, 2, 3])
  })

  it("answers a batch of notifications with 202 and no body", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      [
        { jsonrpc: "2.0", method: "n1" },
        { jsonrpc: "2.0", method: "n2" }
      ],
      { "mcp-session-id": session }
    )
    expect(answer.status).toBe(202)
    expect(await answer.text()).toBe("")
    expect(seen.filter((m) => m.id === undefined)).toHaveLength(2)
  })

  it("answers a mixed batch with results for its requests only", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      [
        { jsonrpc: "2.0", method: "n1" },
        { jsonrpc: "2.0", id: 5, method: "a" }
      ],
      { "mcp-session-id": session }
    )
    const body = (await answer.json()) as Array<{ id: number }>
    expect(body).toHaveLength(1)
    expect(body[0]?.id).toBe(5)
  })

  it("answers a batch over a stream as one batched event", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(
      url,
      [
        { jsonrpc: "2.0", id: 1, method: "a" },
        { jsonrpc: "2.0", id: 2, method: "b" }
      ],
      { "mcp-session-id": session, accept: "text/event-stream" }
    )
    const text = await answer.text()
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? "[]"
    expect(JSON.parse(data)).toHaveLength(2)
  })

  it("refuses an empty batch", async () => {
    const { url } = await start()
    const session = await init(url)
    const answer = await post(url, [], { "mcp-session-id": session })
    expect(answer.status).toBe(400)
  })

  it("refuses an initialize carried inside a batch", async () => {
    const { url } = await start()
    const answer = await post(url, [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "ping" }
    ])
    expect(answer.status).toBe(400)
  })

  it("answers when the request carries a query string", async () => {
    const { url } = await start()
    const session = await init(`${url}?trace=1`)
    expect(session.length).toBeGreaterThan(0)
  })

  it("hands the handler an empty parameter set when none is sent", async () => {
    const { url } = await start()
    const session = await init(url)
    await post(
      url,
      { jsonrpc: "2.0", id: 3, method: "ping", params: 7 },
      { "mcp-session-id": session }
    )
    expect(seen[1]?.params).toEqual({})
  })

  it("carries a message on one stream only when two are open", async () => {
    const { url, endpoint } = await start()
    const session = await init(url)
    const first = await listen(url, { "mcp-session-id": session })
    const second = await listen(url, { "mcp-session-id": session })
    await settle()
    await Effect.runPromise(endpoint.push(session, { seq: "one" }))
    const event = await second.next()
    expect(event.data["seq"]).toBe("one")
    first.stop()
    second.stop()
  })

  it("refuses an origin off the allow list before handling", async () => {
    const { url } = await start()
    const answer = await post(
      url,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { origin: "https://attacker.example" }
    )
    expect(answer.status).toBe(403)
    expect(answer.headers.get("mcp-session-id")).toBeNull()
    expect(seen).toHaveLength(0)
  })

  it("refuses a request that names no origin", async () => {
    const { endpoint } = await start()
    const answer = await fetch(
      `http://${endpoint.host}:${endpoint.port}${endpoint.path}`,
      { method: "POST", body: "{}" }
    )
    expect(answer.status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it("validates the origin on get and delete as well", async () => {
    const { url } = await start()
    const session = await init(url)
    const streamed = await fetch(url, {
      headers: {
        origin: "https://attacker.example",
        accept: "text/event-stream",
        "mcp-session-id": session
      }
    })
    expect(streamed.status).toBe(403)
    await streamed.text()
    const deleted = await fetch(url, {
      method: "DELETE",
      headers: {
        origin: "https://attacker.example",
        "mcp-session-id": session
      }
    })
    expect(deleted.status).toBe(403)
    const later = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { "mcp-session-id": session }
    )
    expect(later.status).toBe(200)
  })

  it("sets the hardening headers on every answer", async () => {
    const { url } = await start()
    const refused = await post(
      url,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { origin: "https://attacker.example" }
    )
    const session = await init(url)
    const served = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { "mcp-session-id": session }
    )
    const stream = await listen(url, { "mcp-session-id": session })
    for (const answer of [refused, served, stream.answer]) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(answer.headers.get(name)).toBe(value)
      }
    }
    stream.stop()
  })

  it("names the headers it took and no more", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual([
      "content-security-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options"
    ])
  })

  it("binds to loopback by default", async () => {
    const { endpoint } = await start(config([ORIGIN], ""))
    expect(endpoint.host).toBe("127.0.0.1")
    const answer = await fetch(
      `http://127.0.0.1:${endpoint.port}${endpoint.path}`,
      { method: "DELETE", headers: { origin: ORIGIN } }
    )
    expect(answer.status).toBe(400)
  })

  it("reports a port it cannot take rather than throwing", async () => {
    const { endpoint } = await start()
    const taken: Config = {
      transport: "http",
      http: { host: "127.0.0.1", port: endpoint.port, origins: [ORIGIN] },
      store: { path: ":memory:" },
      allowWrite: false,
      scopes: [],
      terminologyDir: undefined,
      logLevel: "info",
      trail: { path: ":memory:", key: "", retentionMs: 0 }
    }
    const exit = await Effect.runPromiseExit(serve(taken, handler))
    expect(exit._tag).toBe("Failure")
  })
})
