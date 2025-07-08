import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Socket } from "node:net"
import { Cause, Data, Effect, Exit, Option } from "effect"
import type { Config } from "../config/config.js"

export const ENDPOINT = "/mcp"

export const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'self'"
} as const

const LOOPBACK = "127.0.0.1"
const LIMIT = 1_048_576
const PARSE = -32700
const INVALID = -32600
const INTERNAL = -32603

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly reason: string
}> {}

export interface Fault {
  readonly code: number
  readonly message: string
}

export interface Incoming {
  readonly session: string
  readonly id: string | number | undefined
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

export type Handler = (message: Incoming) => Effect.Effect<unknown, Fault>

export interface Secure {
  readonly cert: string
  readonly key: string
  readonly passphrase: string | undefined
}

export interface Options {
  readonly deletable: boolean
  readonly secure?: Secure
}

interface Listener {
  on(event: "connection", hear: (socket: Socket) => void): void
  on(event: "error", hear: (cause: Error) => void): void
  listen(port: number, host: string, ready: () => void): void
  close(done: (cause?: Error | null) => void): void
  address(): AddressInfo | string | null
}

export interface Endpoint {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly push: (
    session: string,
    message: unknown
  ) => Effect.Effect<boolean>
  readonly end: (session: string) => Effect.Effect<boolean>
  readonly close: Effect.Effect<void>
}

type Body = Readonly<Record<string, unknown>>

type Kind = "request" | "notification" | "response" | "invalid"

interface Stream {
  readonly key: string
  readonly log: Array<{ readonly id: string; readonly data: string }>
  res: ServerResponse | undefined
  seq: number
}

interface Session {
  readonly streams: Map<string, Stream>
  listener: string | undefined
}

const isBody = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const kindOf = (message: Body): Kind => {
  if (message["jsonrpc"] !== "2.0") return "invalid"
  const id = message["id"]
  const method = message["method"]
  if (typeof method === "string") {
    if (id === undefined) return "notification"
    return typeof id === "string" || typeof id === "number"
      ? "request"
      : "invalid"
  }
  return "result" in message || "error" in message ? "response" : "invalid"
}

const paramsOf = (message: Body): Body => {
  const params = message["params"]
  return isBody(params) ? params : {}
}

const headerOf = (
  req: IncomingMessage,
  name: string
): string | undefined => {
  const raw = req.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

const accepts = (req: IncomingMessage, kind: string): boolean =>
  (headerOf(req, "accept") ?? "").includes(kind)

const streamOf = (event: string): string => {
  const cut = event.lastIndexOf("-")
  return cut < 0 ? event : event.slice(0, cut)
}

const seqOf = (event: string): number =>
  Number(event.slice(event.lastIndexOf("-") + 1))

const read = (req: IncomingMessage): Promise<string | undefined> =>
  new Promise((resolve) => {
    const parts: Array<Buffer> = []
    let size = 0
    let over = false
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > LIMIT) {
        over = true
        return
      }
      parts.push(chunk)
    })
    req.on("end", () =>
      resolve(over ? undefined : Buffer.concat(parts).toString("utf8"))
    )
  })

const answered = async (
  handle: Handler,
  session: string,
  message: Body
): Promise<Body> => {
  const id = message["id"] as string | number
  const exit = await Effect.runPromiseExit(
    handle({
      session,
      id,
      method: String(message["method"]),
      params: paramsOf(message)
    })
  )
  if (Exit.isSuccess(exit)) {
    return { jsonrpc: "2.0", id, result: exit.value }
  }
  const fault = Option.getOrElse(
    Cause.failureOption(exit.cause),
    (): Fault => ({ code: INTERNAL, message: "handler failed" })
  )
  return {
    jsonrpc: "2.0",
    id,
    error: { code: fault.code, message: fault.message }
  }
}

const delivered = async (
  handle: Handler,
  session: string,
  message: Body
): Promise<void> => {
  await Effect.runPromiseExit(
    handle({
      session,
      id: undefined,
      method: String(message["method"]),
      params: paramsOf(message)
    })
  )
}

export const serve = (
  config: Config,
  handle: Handler,
  options?: Options
): Effect.Effect<Endpoint, TransportError> =>
  Effect.async<Endpoint, TransportError>((resume) => {
    const sessions = new Map<string, Session>()
    const sockets = new Set<Socket>()
    const deletable = options?.deletable ?? true
    const host =
      config.http.host.trim().length === 0 ? LOOPBACK : config.http.host

    const write = (
      res: ServerResponse,
      status: number,
      body: unknown,
      extra: Record<string, string> = {}
    ): void => {
      const headers: Record<string, string> = { ...SECURITY_HEADERS, ...extra }
      if (body === undefined) {
        if (status !== 204) headers["content-length"] = "0"
        res.writeHead(status, headers)
        res.end()
        return
      }
      const text = JSON.stringify(body)
      headers["content-type"] = "application/json"
      headers["content-length"] = String(Buffer.byteLength(text))
      res.writeHead(status, headers)
      res.end(text)
    }

    const fail = (
      res: ServerResponse,
      status: number,
      code: number,
      message: string,
      extra: Record<string, string> = {}
    ): void =>
      write(
        res,
        status,
        { jsonrpc: "2.0", id: null, error: { code, message } },
        extra
      )

    const stream = (session: Session, key: string): Stream => {
      const known = session.streams.get(key)
      if (known !== undefined) return known
      const made: Stream = { key, log: [], res: undefined, seq: 0 }
      session.streams.set(key, made)
      return made
    }

    const frame = (id: string, data: string): string =>
      `id: ${id}\ndata: ${data}\n\n`

    const emit = (target: Stream, message: unknown): boolean => {
      const res = target.res
      if (res === undefined) return false
      target.seq += 1
      const id = `${target.key}-${target.seq}`
      const data = JSON.stringify(message)
      target.log.push({ id, data })
      res.write(frame(id, data))
      return true
    }

    const attach = (
      target: Stream,
      res: ServerResponse,
      extra: Record<string, string>
    ): void => {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...extra,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      })
      res.flushHeaders()
      target.res = res
      res.on("close", () => {
        if (target.res === res) target.res = undefined
      })
    }

    const terminate = (id: string): boolean => {
      const session = sessions.get(id)
      if (session === undefined) return false
      for (const target of session.streams.values()) target.res?.end()
      sessions.delete(id)
      return true
    }

    const located = (
      res: ServerResponse,
      given: string | undefined
    ): Session | undefined => {
      if (given === undefined) {
        fail(res, 400, INVALID, "session id required")
        return undefined
      }
      const session = sessions.get(given)
      if (session === undefined) {
        fail(res, 404, INVALID, "unknown session")
        return undefined
      }
      return session
    }

    const streamed = async (
      res: ServerResponse,
      session: Session,
      id: string,
      requests: ReadonlyArray<Body>,
      batch: boolean,
      extra: Record<string, string>
    ): Promise<void> => {
      const target = stream(session, randomUUID().slice(0, 8))
      attach(target, res, extra)
      const answers: Array<Body> = []
      for (const request of requests) {
        answers.push(await answered(handle, id, request))
      }
      emit(target, batch ? answers : (answers[0] ?? null))
      res.end()
    }

    const posted = async (
      req: IncomingMessage,
      res: ServerResponse,
      given: string | undefined
    ): Promise<void> => {
      const text = await read(req)
      if (text === undefined) {
        return fail(res, 413, INVALID, "body too large")
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(text)
      } catch {
        return fail(res, 400, PARSE, "body is not json")
      }
      const batch = Array.isArray(decoded)
      const raw: ReadonlyArray<unknown> = Array.isArray(decoded)
        ? decoded
        : [decoded]
      if (raw.length === 0) {
        return fail(res, 400, INVALID, "empty batch")
      }
      const entries: Array<Body> = []
      for (const entry of raw) {
        if (!isBody(entry) || kindOf(entry) === "invalid") {
          return fail(res, 400, INVALID, "not a message")
        }
        entries.push(entry)
      }
      const initializes = entries.filter(
        (entry) => entry["method"] === "initialize"
      )
      if (batch && initializes.length > 0) {
        return fail(res, 400, INVALID, "initialize is never batched")
      }
      let id: string
      let extra: Record<string, string> = {}
      if (initializes.length > 0) {
        id = randomUUID()
        sessions.set(id, { streams: new Map(), listener: undefined })
        extra = { "mcp-session-id": id }
      } else {
        const session = located(res, given)
        if (session === undefined || given === undefined) return
        id = given
      }
      const session = sessions.get(id)
      if (session === undefined) return
      const requests = entries.filter((entry) => kindOf(entry) === "request")
      for (const entry of entries) {
        if (kindOf(entry) === "notification") {
          await delivered(handle, id, entry)
        }
      }
      if (requests.length === 0) {
        return write(res, 202, undefined, extra)
      }
      const wanted =
        accepts(req, "text/event-stream") && !accepts(req, "application/json")
      if (wanted) return streamed(res, session, id, requests, batch, extra)
      const answers: Array<Body> = []
      for (const request of requests) {
        answers.push(await answered(handle, id, request))
      }
      write(res, 200, batch ? answers : (answers[0] ?? null), extra)
    }

    const listened = (
      req: IncomingMessage,
      res: ServerResponse,
      given: string | undefined
    ): void => {
      const session = located(res, given)
      if (session === undefined) return
      if (!accepts(req, "text/event-stream")) {
        return fail(res, 406, INVALID, "a stream is not accepted")
      }
      const last = headerOf(req, "last-event-id")
      const resumed =
        last === undefined ? undefined : session.streams.get(streamOf(last))
      const target = resumed ?? stream(session, randomUUID().slice(0, 8))
      attach(target, res, {})
      session.listener = target.key
      res.on("close", () => {
        if (session.listener === target.key) session.listener = undefined
      })
      if (resumed === undefined || last === undefined) return
      const after = seqOf(last)
      for (const event of resumed.log) {
        if (seqOf(event.id) > after) res.write(frame(event.id, event.data))
      }
    }

    const removed = (
      res: ServerResponse,
      given: string | undefined
    ): void => {
      if (!deletable) {
        return fail(res, 405, INVALID, "sessions are server-ended", {
          allow: "GET, POST"
        })
      }
      if (located(res, given) === undefined || given === undefined) return
      terminate(given)
      write(res, 204, undefined)
    }

    const route = async (
      req: IncomingMessage,
      res: ServerResponse
    ): Promise<void> => {
      const origin = headerOf(req, "origin")
      if (origin === undefined || !config.http.origins.includes(origin)) {
        return fail(res, 403, INVALID, "origin refused")
      }
      const path = (req.url ?? "").split("?")[0]
      if (path !== ENDPOINT) {
        return fail(res, 404, INVALID, "no such endpoint")
      }
      const given = headerOf(req, "mcp-session-id")
      if (req.method === "POST") return posted(req, res, given)
      if (req.method === "GET") return listened(req, res, given)
      if (req.method === "DELETE") return removed(res, given)
      fail(res, 405, INVALID, "method not answered here", {
        allow: "GET, POST, DELETE"
      })
    }

    const secure = options?.secure
    const server: Listener =
      secure === undefined
        ? createServer((req, res) => {
            void route(req, res)
          })
        : createSecureServer(
            {
              cert: secure.cert,
              key: secure.key,
              ...(secure.passphrase === undefined ? {} : { passphrase: secure.passphrase })
            },
            (req, res) => {
              void route(req, res)
            }
          )

    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })

    let started = false
    server.on("error", (cause) => {
      if (started) return
      started = true
      resume(Effect.fail(new TransportError({ reason: cause.message })))
    })

    server.listen(config.http.port, host, () => {
      if (started) return
      started = true
      const address = server.address()
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : config.http.port
      resume(
        Effect.succeed({
          host,
          port,
          path: ENDPOINT,
          push: (id: string, message: unknown) =>
            Effect.sync(() => {
              const session = sessions.get(id)
              const key = session?.listener
              const target =
                session === undefined || key === undefined
                  ? undefined
                  : session.streams.get(key)
              return target === undefined ? false : emit(target, message)
            }),
          end: (id: string) => Effect.sync(() => terminate(id)),
          close: Effect.async<void>((done) => {
            for (const id of [...sessions.keys()]) terminate(id)
            for (const socket of sockets) socket.destroy()
            server.close(() => done(Effect.void))
          })
        })
      )
    })
  })
