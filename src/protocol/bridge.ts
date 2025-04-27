import { Effect } from "effect"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage, JSONRPCResponse } from "@modelcontextprotocol/sdk/types.js"
import type { Endpoint, Fault, Handler, Incoming } from "./http.js"

const NOREPLY = -32000

export const NOREPLY_REASON = "this transport carries no reply from the client"

export interface Bridged {
  readonly handler: Handler
  readonly attach: (endpoint: Endpoint) => void
}

interface Pending {
  readonly session: string
  readonly outer: string | number
  readonly answer: (answer: JSONRPCResponse) => void
}

const keyOf = (session: string, id: string | number): string =>
  `${session}\u0000${typeof id}:${String(id)}`

export const bridged = (server: Server): Effect.Effect<Bridged, Error> =>
  Effect.tryPromise({
    try: async () => {
      const waiting = new Map<number, Pending>()
      const inner = new Map<string, number>()
      let next = 0
      let sink: Endpoint | undefined
      let current: string | undefined

      const settle = (id: number): Pending | undefined => {
        const held = waiting.get(id)
        if (held === undefined) return undefined
        waiting.delete(id)
        inner.delete(keyOf(held.session, held.outer))
        return held
      }

      const transport: Transport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (message: JSONRPCMessage, options?: TransportSendOptions) => {
          const id = "id" in message ? message.id : undefined
          if (id !== undefined && ("result" in message || "error" in message)) {
            settle(id as number)?.answer(message as JSONRPCResponse)
            return
          }
          if (id !== undefined) {
            transport.onmessage?.({
              jsonrpc: "2.0",
              id,
              error: { code: NOREPLY, message: NOREPLY_REASON }
            } as JSONRPCMessage)
            return
          }
          const related = options?.relatedRequestId
          const owner =
            related === undefined ? current : waiting.get(related as number)?.session
          if (sink === undefined || owner === undefined) return
          await Effect.runPromise(sink.push(owner, message))
        }
      }

      await server.connect(transport)

      const handler: Handler = (incoming: Incoming) =>
        Effect.async<unknown, Fault>((resume) => {
          current = incoming.session
          transport.sessionId = incoming.session
          const outer = incoming.id
          if (outer === undefined) {
            const params = { ...incoming.params }
            if (incoming.method === "notifications/cancelled") {
              const asked = params["requestId"]
              const mapped =
                typeof asked === "string" || typeof asked === "number"
                  ? inner.get(keyOf(incoming.session, asked))
                  : undefined
              if (mapped === undefined) {
                resume(Effect.succeed(undefined))
                return
              }
              params["requestId"] = mapped
            }
            transport.onmessage?.({
              jsonrpc: "2.0",
              method: incoming.method,
              params
            } as JSONRPCMessage)
            resume(Effect.succeed(undefined))
            return
          }
          next += 1
          const id = next
          waiting.set(id, {
            session: incoming.session,
            outer,
            answer: (answer) => {
              if ("error" in answer) {
                resume(Effect.fail({ code: answer.error.code, message: answer.error.message }))
                return
              }
              resume(Effect.succeed(answer.result))
            }
          })
          inner.set(keyOf(incoming.session, outer), id)
          transport.onmessage?.({
            jsonrpc: "2.0",
            id,
            method: incoming.method,
            params: incoming.params
          } as JSONRPCMessage)
        })

      return {
        handler,
        attach: (endpoint: Endpoint) => {
          sink = endpoint
        }
      }
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("the bridge was not built")
  })
