import { Duration, Effect, Option } from "effect"
import { inflateSync } from "node:zlib"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Fetcher {
  readonly get: (url: string) => Effect.Effect<Uint8Array, Failure>
}

export interface AttachmentRequest {
  readonly url: string
  readonly format?: string
  readonly retries?: number
  readonly retryAfterMs?: number
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

export interface Extracted {
  readonly url: string
  readonly format: string
  readonly encoding?: string
  readonly text: string
  readonly source: "network" | "cache"
}

export interface Cached {
  readonly encoding?: string
  readonly text: string
}

export interface AttachmentCache {
  readonly read: (url: string) => Effect.Effect<Option.Option<Cached>>
  readonly write: (url: string, value: Cached) => Effect.Effect<void, never, never>
}

const FORMATS = ["txt", "csv", "json", "pdf"] as const

type Format = (typeof FORMATS)[number]

const isFormat = (value: string): value is Format =>
  (FORMATS as ReadonlyArray<string>).includes(value)

const refused = (reason: string): Effect.Effect<never, Rejected> =>
  Effect.fail(new Rejected({ reason }))

const schemeOf = (url: string): string => {
  const at = url.indexOf(":")
  return at === -1 ? url : url.slice(0, at)
}

export const boundedCache = (bound: number): AttachmentCache => {
  const entries = new Map<string, Cached>()
  return {
    read: (url) =>
      Effect.sync(() => {
        const found = entries.get(url)
        if (found === undefined) return Option.none()
        entries.delete(url)
        entries.set(url, found)
        return Option.some(found)
      }),
    write: (url, value) =>
      Effect.sync(() => {
        if (entries.has(url)) entries.delete(url)
        entries.set(url, value)
        while (entries.size > bound) {
          const oldest = entries.keys().next().value
          if (oldest !== undefined) entries.delete(oldest)
        }
      })
  }
}

const decodeText = (bytes: Uint8Array): { readonly encoding: string; readonly text: string } => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", text: new TextDecoder("utf-16le").decode(bytes) }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", text: new TextDecoder("utf-8").decode(bytes.subarray(3)) }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return { encoding: "utf-8", text }
  } catch {
    return { encoding: "windows-1252", text: new TextDecoder("windows-1252").decode(bytes) }
  }
}

const rowOf = (row: string): ReadonlyArray<string> => {
  const fields: Array<string> = []
  let field = ""
  let quoted = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (quoted) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      fields.push(field)
      field = ""
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}

const csvOf = (text: string): string => {
  const rows = text.split("\n")
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop()
  return rows.map((row) => rowOf(row).join(", ")).join("\n")
}

const indexOfBytes = (hay: Uint8Array, needle: string, from: number): number => {
  const wanted = new TextEncoder().encode(needle)
  outer: for (let at = from; at + wanted.length <= hay.length; at++) {
    for (let off = 0; off < wanted.length; off++) {
      if (hay[at + off] !== wanted[off]) continue outer
    }
    return at
  }
  return -1
}

const pdfText = (bytes: Uint8Array): Effect.Effect<string, Rejected> => {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 5))
  if (!head.startsWith("%PDF")) {
    return refused("not a pdf: header missing")
  }
  const start = indexOfBytes(bytes, "stream", 0)
  const end = indexOfBytes(bytes, "endstream", 0)
  if (start === -1 || end === -1 || end <= start) {
    return refused("not a pdf: stream missing")
  }
  const from = start + "stream".length
  let body = bytes.subarray(from, end)
  if (body.length > 0 && body[0] === 0x0a) body = body.subarray(1)
  if (body.length > 0 && body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 1)
  try {
    const inflated = inflateSync(body).toString("utf8")
    const parts = [...inflated.matchAll(/\(([^()]*)\)/g)].map((found) => found[1] as string)
    return Effect.succeed(parts.join("\n"))
  } catch {
    return refused("not a pdf: stream does not inflate")
  }
}

const decoded = (
  format: Format,
  bytes: Uint8Array
): Effect.Effect<{ readonly encoding?: string; readonly text: string }, Rejected> => {
  if (format === "pdf") return Effect.map(pdfText(bytes), (text) => ({ text }))
  const { encoding, text } = decodeText(bytes)
  if (format === "json") {
    try {
      const parsed = JSON.parse(text) as unknown
      return Effect.succeed({ encoding, text: JSON.stringify(parsed, undefined, 2) })
    } catch {
      return refused(`not json: ${text}`)
    }
  }
  if (format === "csv") return Effect.succeed({ encoding, text: csvOf(text) })
  return Effect.succeed({ encoding, text })
}

const fetched = (
  url: string,
  request: AttachmentRequest,
  fetcher: Fetcher
): Effect.Effect<Uint8Array, Failure> => {
  const retryAfterMs = request.retryAfterMs
  const loop = (left: number): Effect.Effect<Uint8Array, Failure> =>
    fetcher.get(url).pipe(
      Effect.catchAll((failure) =>
        failure._tag === "Unavailable" && left > 0 && retryAfterMs !== undefined
          ? Effect.sleep(Duration.millis(retryAfterMs)).pipe(Effect.zipRight(loop(left - 1)))
          : Effect.fail(failure)
      )
    )
  const inner = loop(request.retries ?? 0)
  if (request.timeoutMs === undefined) return inner
  return inner.pipe(
    Effect.timeoutTo({
      duration: Duration.millis(request.timeoutMs),
      onTimeout: () => null,
      onSuccess: (bytes: Uint8Array) => bytes
    }),
    Effect.flatMap((timeoutBytes) =>
      timeoutBytes === null
        ? refused(`attachment timed out after ${request.timeoutMs ?? 0}ms`)
        : Effect.succeed(timeoutBytes)
    )
  )
}

const found = (
  url: string,
  format: string,
  encoding: string | undefined,
  text: string,
  source: "network" | "cache"
): Extracted =>
  encoding === undefined
    ? { url, format, text, source }
    : { url, format, encoding, text, source }

export const extract = (
  request: AttachmentRequest,
  fetcher: Fetcher,
  cache?: AttachmentCache
): Effect.Effect<Extracted, Failure> =>
  Effect.gen(function* () {
    const format = request.format ?? "txt"
    if (!isFormat(format)) {
      return yield* refused(`format ${format} is not supported; supported: ${FORMATS.join(", ")}`)
    }
    const url = request.url
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return yield* refused(
        `refuse ${schemeOf(url)} address; only http and https can be fetched`
      )
    }
    if (cache !== undefined) {
      const hit = yield* cache.read(url)
      if (Option.isSome(hit)) {
        return found(url, format, hit.value.encoding, hit.value.text, "cache")
      }
    }
    const bytes = yield* fetched(url, request, fetcher)
    if (request.maxBytes !== undefined && bytes.length > request.maxBytes) {
      return yield* refused(`attachment exceeds the ${request.maxBytes} byte bound`)
    }
    const { encoding, text } = yield* decoded(format, bytes)
    if (cache !== undefined) {
      const cached: Cached = encoding === undefined ? { text } : { encoding, text }
      yield* cache.write(url, cached)
    }
    return found(url, format, encoding, text, "network")
  })