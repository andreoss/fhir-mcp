import { Effect } from "effect"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage, JSONRPCResponse } from "@modelcontextprotocol/sdk/types.js"
import type { Endpoint, Fault, Handler, Incoming } from "./http.js"

const NOREPLY = -32000

export const NOREPLY_REASON = "this transport carries no reply from the client"

export interface Bridged {
  readonly handler: Handler
  readonly attach: (endpoint: Endpoint) => void
}

export const bridged = (server: Server): Effect.Effect<Bridged, Error> =>
  Effect.tryPromise({
    try: async () => {
      const waiting = new Map<string | number, (answer: JSONRPCResponse) => void>()
      let sink: Endpoint | undefined
      let current: string | undefined

      const transport: Transport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (message: JSONRPCMessage) => {
          const id = "id" in message ? message.id : undefined
          if (id !== undefined && ("result" in message || "error" in message)) {
            const held = waiting.get(id)
            waiting.delete(id)
            held?.(message as JSONRPCResponse)
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
          if (sink === undefined || current === undefined) return
          await Effect.runPromise(sink.push(current, message))
        }
      }

      await server.connect(transport)

      const handler: Handler = (incoming: Incoming) =>
        Effect.async<unknown, Fault>((resume) => {
          current = incoming.session
          transport.sessionId = incoming.session
          const id = incoming.id
          if (id === undefined) {
            transport.onmessage?.({
              jsonrpc: "2.0",
              method: incoming.method,
              params: incoming.params
            } as JSONRPCMessage)
            resume(Effect.succeed(undefined))
            return
          }
          waiting.set(id, (answer: JSONRPCResponse) => {
            if ("error" in answer) {
              resume(
                Effect.fail({ code: answer.error.code, message: answer.error.message })
              )
              return
            }
            resume(Effect.succeed(answer.result))
          })
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
