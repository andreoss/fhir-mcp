import * as http from "node:http"
import * as https from "node:https"
import { Effect } from "effect"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Bound {
  readonly dependency: string
  readonly timeoutMs: number
  readonly retryAfterMs: number
}

export interface Answer {
  readonly status: number
  readonly url: string
  readonly headers: Record<string, string | undefined>
  readonly body: string
}

export type Opener = (
  url: string,
  options: { method: string; headers: Record<string, string> },
  onResponse: (res: {
    readonly statusCode: number | undefined
    readonly headers: Record<string, string | Array<string> | undefined>
    readonly setEncoding: (enc: string) => void
    readonly on: (event: string, listener: (value: never) => void) => void
  }) => void
) => {
  readonly on: (event: string, listener: (value: never) => void) => void
  readonly setTimeout: (ms: number) => void
  readonly destroy: () => void
  readonly write: (chunk: string) => void
  readonly end: () => void
}

export interface SendRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body?: string | undefined
  readonly bound: Bound
}

export interface Transport {
  readonly send: (request: SendRequest) => Effect.Effect<Answer, Failure>
}

const RETRY_PATTERN = /\(retry after (\d+)ms\)/

export const stalled = (bound: Bound): Unavailable =>
  new Unavailable({ dependency: `${bound.dependency} (retry after ${bound.retryAfterMs}ms)` })

export const stalledFor = (bound: Bound, ms: number): Unavailable =>
  new Unavailable({ dependency: `${bound.dependency} (retry after ${ms}ms)` })

export const retryAfter = (failure: Failure): number | undefined => {
  if (failure._tag !== "Unavailable") return undefined
  const match = failure.dependency.match(RETRY_PATTERN)
  return match !== null ? Number(match[1]) : undefined
}

export const waitOf = (answer: Answer, fallback: number): number => {
  const raw = answer.headers["retry-after"]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallback
}

export const jsonOf = (body: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const joinHeaders = (
  headers: Record<string, string | Array<string> | undefined>
): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {}
  for (const key of Object.keys(headers)) {
    const value = headers[key]
    const lower = key.toLowerCase()
    if (value === undefined) {
      result[lower] = undefined
    } else if (Array.isArray(value)) {
      result[lower] = value.join(", ")
    } else {
      result[lower] = value
    }
  }
  return result
}

export const over = (opener: Opener): Transport => ({
  send: (request) =>
    Effect.async<Answer, Failure>((resume) => {
      let resolved = false

      const socket = opener(
        request.url,
        { method: request.method, headers: request.headers },
        (res) => {
          const chunks: Array<string> = []
          res.setEncoding("utf-8")
          res.on("data", ((chunk: string) => {
            chunks.push(chunk)
          }) as (value: never) => void)
          res.on("end", (() => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            resume(
              Effect.succeed({
                status: res.statusCode ?? 0,
                url: request.url,
                headers: joinHeaders(res.headers),
                body: chunks.join("")
              })
            )
          }) as (value: never) => void)
        }
      )

      socket.setTimeout(request.bound.timeoutMs)

      const fail = () => {
        if (resolved) return
        resolved = true
        resume(Effect.fail(stalled(request.bound)))
      }

      const timer = setTimeout(fail, request.bound.timeoutMs)

      socket.on("error", (() => {
        clearTimeout(timer)
        fail()
      }) as (value: never) => void)

      socket.on("timeout", (() => {
        clearTimeout(timer)
        socket.destroy()
        fail()
      }) as (value: never) => void)

      if (request.body !== undefined) {
        socket.write(request.body)
        socket.end()
      }
    })
})

const realOpener: Opener = (url, options, onResponse) => {
  const parsed = new URL(url)
  const mod = parsed.protocol === "https:" ? https : http
  const req = mod.request(url, { method: options.method, headers: options.headers }, (res) => {
    onResponse({
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | Array<string> | undefined>,
      setEncoding: (enc) => {
        res.setEncoding(enc as BufferEncoding)
      },
      on: ((event: string, listener: (value: never) => void) => {
        res.on(event, listener as (...args: ReadonlyArray<unknown>) => void)
      }) as (event: string, listener: (value: never) => void) => void
    })
  })

  return {
    on: ((event: string, listener: (value: never) => void) => {
      req.on(event, listener as (...args: ReadonlyArray<unknown>) => void)
    }) as (event: string, listener: (value: never) => void) => void,
    setTimeout: (ms) => {
      req.setTimeout(ms)
    },
    destroy: () => {
      req.destroy()
    },
    write: (chunk) => {
      req.write(chunk)
    },
    end: () => {
      req.end()
    }
  }
}

export const node = (): Transport => over(realOpener)
