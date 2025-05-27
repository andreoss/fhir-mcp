import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { deflateSync } from "node:zlib"
import { toOutcome } from "../core/outcome.js"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { boundedCache, extract } from "./attachment.js"
import type { Fetcher } from "./attachment.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

const upsert = (
  plan: (url: string) => Effect.Effect<Uint8Array, Failure>
): { seen: Array<string>; fetcher: Fetcher } => {
  const seen: Array<string> = []
  return {
    seen,
    fetcher: { get: (url) => { seen.push(url); return plan(url) } }
  }
}

const failure = async (effect: Effect.Effect<unknown, Failure>): Promise<Failure> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a failure")
}

const pdfOf = (content: string): Uint8Array => {
  const deflated = deflateSync(Buffer.from(content))
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + deflated.length + " >>\nstream\n"),
    deflated,
    Buffer.from("\nendstream\nendobj\n%%EOF")
  ])
}

interface Run {
  readonly url: string
  readonly format?: string
  readonly retries?: number
  readonly retryAfterMs?: number
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

const call = (
  run: Run,
  fetcher: Fetcher,
  cache?: ReturnType<typeof boundedCache>
) =>
  extract(
    {
      url: run.url,
      format: run.format ?? "txt",
      ...(run.retries === undefined ? {} : { retries: run.retries }),
      ...(run.retryAfterMs === undefined ? {} : { retryAfterMs: run.retryAfterMs }),
      ...(run.maxBytes === undefined ? {} : { maxBytes: run.maxBytes }),
      ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs })
    },
    fetcher,
    cache
  )

describe("attachment decoding", () => {
  it("fetches a text attachment and names the detected encoding", async () => {
    const held = upsert(() => Effect.succeed(utf8("discharge summary\npage one")))
    const found = await Effect.runPromise(call({ url: "https://docs.example/a.txt" }, held.fetcher))
    expect(found).toMatchObject({
      url: "https://docs.example/a.txt",
      format: "txt",
      encoding: "utf-8",
      text: "discharge summary\npage one",
      source: "network"
    })
  })

  it("stripes a byte-order mark from utf-8", async () => {
    const held = upsert(() => Effect.succeed(utf8("\uFEFFnote")))
    const found = await Effect.runPromise(call({ url: "https://docs.example/b.txt" }, held.fetcher))
    expect(found.encoding).toBe("utf-8")
    expect(found.text).toBe("note")
  })

  it("decodes content that is not utf-8 by the detected fallback", async () => {
    const held = upsert(() => Effect.succeed(new Uint8Array([0x48, 0xe9])))
    const found = await Effect.runPromise(call({ url: "https://docs.example/c.txt" }, held.fetcher))
    expect(found.encoding).toBe("windows-1252")
    expect(found.text).toBe("Hé")
  })

  it("decodes a utf-16 little-endian attachment", async () => {
    const encoded = new TextEncoder().encode("Hi").map(() => 0)
    const utf16 = Buffer.alloc(2 + 4)
    utf16[0] = 0xff
    utf16[1] = 0xfe
    utf16.write("Hi", 2, "utf16le")
    const held = upsert(() => Effect.succeed(new Uint8Array(utf16)))
    const found = await Effect.runPromise(call({ url: "https://docs.example/d.txt" }, held.fetcher))
    expect(found.encoding).toBe("utf-16le")
    expect(found.text).toBe("Hi")
    expect(encoded).toHaveLength(2)
  })

  it("joins csv rows the same way for every row", async () => {
    const held = upsert(() => Effect.succeed(utf8("code,display\n1,Alpha\n2,Beta")))
    const found = await Effect.runPromise(call({ url: "https://docs.example/e.csv", format: "csv" }, held.fetcher))
    expect(found.text).toBe("code, display\n1, Alpha\n2, Beta")
  })

  it("keeps a quoted field together in csv", async () => {
    const held = upsert(() => Effect.succeed(utf8('"said, ""hi""",2')))
    const found = await Effect.runPromise(call({ url: "https://docs.example/f.csv", format: "csv" }, held.fetcher))
    expect(found.text).toBe('said, "hi", 2')
  })

  it("prettifies a json attachment", async () => {
    const held = upsert(() => Effect.succeed(utf8('{"a":1,"b":[1,2]}')))
    const found = await Effect.runPromise(call({ url: "https://docs.example/g.json", format: "json" }, held.fetcher))
    expect(JSON.parse(found.text)).toEqual({ a: 1, b: [1, 2] })
    expect(found.text).toContain("\n")
  })

  it("refuses text that is declared json but is not", async () => {
    const held = upsert(() => Effect.succeed(utf8("this is not json")))
    const error = await failure(call({ url: "https://docs.example/h.json", format: "json" }, held.fetcher))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("not json")
  })

  it("extracts the text of a pdf attachment", async () => {
    const held = upsert(() => Effect.succeed(pdfOf("(Hello world) Tj\n(Second line) Tj")))
    const found = await Effect.runPromise(call({ url: "https://docs.example/i.pdf", format: "pdf" }, held.fetcher))
    expect(found.text).toContain("Hello world")
    expect(found.text).toContain("Second line")
  })

  it("reports an empty text layer rather than refusing a pdf", async () => {
    const held = upsert(() => Effect.succeed(pdfOf("(scan) rg")))
    const found = await Effect.runPromise(call({ url: "https://docs.example/j.pdf", format: "pdf" }, held.fetcher))
    expect(found.text).toBe("scan")
  })

  it("refuses a payload that claims pdf and is not", async () => {
    const held = upsert(() => Effect.succeed(utf8("not a pdf at all")))
    const error = await failure(call({ url: "https://docs.example/k.pdf", format: "pdf" }, held.fetcher))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("not a pdf")
  })
})

describe("attachment refusal", () => {
  it("refuses an undeclared format with the reason", async () => {
    const held = upsert(() => Effect.succeed(utf8("x")))
    const error = await failure(call({ url: "https://docs.example/a.docx", format: "docx" }, held.fetcher))
    expect(error._tag).toBe("Rejected")
    const diagnostics = toOutcome(error).issue[0]?.diagnostics ?? ""
    expect(diagnostics).toContain("docx")
    expect(diagnostics).toContain("pdf")
  })

  it("refuses an address that is not an http fetch", async () => {
    const held = upsert(() => Effect.succeed(utf8("x")))
    const error = await failure(call({ url: "file:///etc/passwd", format: "txt" }, held.fetcher))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("file")
  })

  it("names an authentication refusal as a refusal", async () => {
    const held = upsert(() => Effect.fail(new Rejected({ reason: "attachment refused at 401: authentication" })))
    const error = await failure(call({ url: "https://docs.example/a.txt" }, held.fetcher))
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("authentication")
  })

  it("names the byte bound when an attachment exceeds it", async () => {
    const held = upsert(() => Effect.succeed(new Uint8Array(64)))
    const error = await failure(call({ url: "https://docs.example/a.txt", maxBytes: 32 }, held.fetcher))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("32")
  })
})

describe("attachment waits and retries", () => {
  it("makes a transport fault an unavailable outcome naming the wait", async () => {
    const held = upsert(() =>
      Effect.fail(new Unavailable({ dependency: "attachment (retry after 800ms)" }))
    )
    const error = await failure(call({ url: "https://docs.example/a.txt", retryAfterMs: 800 }, held.fetcher))
    expect(error._tag).toBe("Unavailable")
    expect(toOutcome(error).issue[0]?.code).toBe("transient")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("800")
  })

  it("retries a transient fault when the request says so", async () => {
    let calls = 0
    const held = upsert(() => {
      calls += 1
      return calls === 1
        ? Effect.fail(new Unavailable({ dependency: "attachment (retry after 5ms)" }))
        : Effect.succeed(utf8("recovered"))
    })
    const found = await Effect.runPromise(
      call({ url: "https://docs.example/a.txt", retries: 1, retryAfterMs: 5 }, held.fetcher)
    )
    expect(held.seen).toHaveLength(2)
    expect(found.text).toBe("recovered")
  })

  it("does not retry past the allowance given", async () => {
    const held = upsert(() =>
      Effect.fail(new Unavailable({ dependency: "attachment (retry after 5ms)" }))
    )
    const error = await failure(
      call({ url: "https://docs.example/a.txt", retries: 1, retryAfterMs: 5 }, held.fetcher)
    )
    expect(error._tag).toBe("Unavailable")
    expect(held.seen).toHaveLength(2)
  })

  it("measures each wait against the bound given", async () => {
    const held = upsert(() => Effect.succeed(utf8("ok")))
    const found = await Effect.runPromise(
      call({ url: "https://docs.example/a.txt", timeoutMs: 250 }, held.fetcher)
    )
    expect(found.text).toBe("ok")
  })
})

describe("attachment cache", () => {
  it("does the work once for the same document", async () => {
    let calls = 0
    const held = upsert(() => {
      calls += 1
      return Effect.succeed(utf8("once"))
    })
    const cache = boundedCache(4)
    const first = await Effect.runPromise(call({ url: "https://docs.example/a.txt" }, held.fetcher, cache))
    const second = await Effect.runPromise(call({ url: "https://docs.example/a.txt" }, held.fetcher, cache))
    expect(calls).toBe(1)
    expect(first.source).toBe("network")
    expect(second.source).toBe("cache")
    expect(second.text).toBe("once")
  })

  it("evicts the oldest entry to stay inside its bound", async () => {
    const seen: Array<string> = []
    const held = upsert(() => {
      seen.push("called")
      return Effect.succeed(utf8("x"))
    })
    const cache = boundedCache(1)
    await Effect.runPromise(call({ url: "https://docs.example/a.txt" }, held.fetcher, cache))
    await Effect.runPromise(call({ url: "https://docs.example/b.txt" }, held.fetcher, cache))
    await Effect.runPromise(call({ url: "https://docs.example/a.txt" }, held.fetcher, cache))
    expect(seen).toHaveLength(3)
  })
})