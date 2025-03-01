import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import {
  jsonOf,
  node,
  over,
  retryAfter,
  stalled,
  stalledFor,
  waitOf
} from "./wire.js"
import type { Answer, Bound, Opener } from "./wire.js"

const BOUND: Bound = { dependency: "emr", timeoutMs: 60, retryAfterMs: 250 }

interface Note {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  destroyed: boolean
}

type Reply =
  | {
    readonly kind: "answer"
    readonly status: number | undefined
    readonly headers: Record<string, string | Array<string> | undefined>
    readonly chunks: ReadonlyArray<string>
  }
  | { readonly kind: "timeout" }
  | { readonly kind: "error" }
  | { readonly kind: "silent" }

const bus = () => {
  const held = new Map<string, Array<(value: never) => void>>()
  return {
    on: (event: string, listener: (value: never) => void) => {
      held.set(event, [...(held.get(event) ?? []), listener])
    },
    emit: (event: string, value: unknown) => {
      for (const listener of held.get(event) ?? []) {
        (listener as unknown as (given: unknown) => void)(value)
      }
    }
  }
}

const answering = (
  status: number,
  headers: Record<string, string | Array<string> | undefined>,
  chunks: ReadonlyArray<string>
): Reply => ({ kind: "answer", status, headers, chunks })

const opener = (plan: (note: Note) => Reply) => {
  const seen: Array<Note> = []
  const open: Opener = (url, options, onResponse) => {
    const note: Note = {
      url,
      method: options.method,
      headers: { ...options.headers },
      body: "",
      timeoutMs: 0,
      destroyed: false
    }
    seen.push(note)
    const channel = bus()
    queueMicrotask(() => {
      const reply = plan(note)
      if (reply.kind === "timeout") return channel.emit("timeout", undefined)
      if (reply.kind === "error") return channel.emit("error", undefined)
      if (reply.kind === "silent") return
      const stream = bus()
      onResponse({
        statusCode: reply.status,
        headers: reply.headers,
        setEncoding: () => {},
        on: stream.on
      })
      for (const chunk of reply.chunks) stream.emit("data", chunk)
      stream.emit("end", undefined)
    })
    return {
      on: channel.on,
      setTimeout: (ms: number) => {
        note.timeoutMs = ms
      },
      destroy: () => {
        note.destroyed = true
      },
      write: (chunk: string) => {
        note.body += chunk
      },
      end: () => {}
    }
  }
  return { open, seen }
}

const sent = (plan: (note: Note) => Reply, body: string | undefined = undefined) => {
  const fake = opener(plan)
  const exit = Effect.runPromiseExit(
    over(fake.open).send({
      method: body === undefined ? "GET" : "POST",
      url: "https://emr.example/fhir/Patient/1",
      headers: { accept: "application/fhir+json" },
      body,
      bound: BOUND
    })
  )
  return { exit, seen: fake.seen }
}

const value = (exit: Exit.Exit<Answer, Failure>): Answer => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected an answer")
}

const failure = (exit: Exit.Exit<Answer, Failure>): Failure => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a failure")
}

describe("outbound calls", () => {
  it("carries the method, address, headers and body", async () => {
    const run = sent(() => answering(200, {}, ["{}"]), "grant_type=x")
    await run.exit
    expect(run.seen[0]?.method).toBe("POST")
    expect(run.seen[0]?.url).toBe("https://emr.example/fhir/Patient/1")
    expect(run.seen[0]?.headers["accept"]).toBe("application/fhir+json")
    expect(run.seen[0]?.body).toBe("grant_type=x")
  })

  it("assembles the answer from its chunks", async () => {
    const run = sent(() =>
      answering(200, { "Content-Type": "application/fhir+json" }, ["{\"a\":", "1}"])
    )
    const answer = value(await run.exit)
    expect(answer.status).toBe(200)
    expect(answer.body).toBe("{\"a\":1}")
    expect(answer.headers["content-type"]).toBe("application/fhir+json")
    expect(answer.url).toBe("https://emr.example/fhir/Patient/1")
  })

  it("joins a repeated header and drops an absent one", async () => {
    const run = sent(() => answering(200, { Vary: ["a", "b"], Warn: undefined }, []))
    const answer = value(await run.exit)
    expect(answer.headers["vary"]).toBe("a, b")
    expect(answer.headers["warn"]).toBeUndefined()
  })

  it("reports a missing status as zero", async () => {
    const run = sent(() => ({ kind: "answer", status: undefined, headers: {}, chunks: [] }))
    expect(value(await run.exit).status).toBe(0)
  })

  it("bounds the wait with the configured timeout", async () => {
    const run = sent(() => answering(200, {}, []))
    await run.exit
    expect(run.seen[0]?.timeoutMs).toBe(60)
  })

  it("turns a socket fault into an unavailable dependency", async () => {
    const run = sent(() => ({ kind: "error" }))
    const found = failure(await run.exit)
    expect(found._tag).toBe("Unavailable")
    expect(retryAfter(found)).toBe(250)
  })

  it("destroys the channel when the socket times out", async () => {
    const run = sent(() => ({ kind: "timeout" }))
    expect(failure(await run.exit)._tag).toBe("Unavailable")
    expect(run.seen[0]?.destroyed).toBe(true)
  })

  it("never lets a silent upstream hang the caller", async () => {
    const run = sent(() => ({ kind: "silent" }))
    const found = failure(await run.exit)
    expect(found._tag).toBe("Unavailable")
    expect(retryAfter(found)).toBe(250)
  })

  it("builds a transport over node without calling out", () => {
    expect(typeof node().send).toBe("function")
  })
})

describe("retry hints", () => {
  it("names the dependency and the delay", () => {
    expect(stalled(BOUND).dependency).toBe("emr (retry after 250ms)")
  })

  it("carries a delay taken from the answer", () => {
    expect(retryAfter(stalledFor(BOUND, 4_000))).toBe(4_000)
  })

  it("has no hint for another failure", () => {
    expect(retryAfter(new Rejected({ reason: "no" }))).toBeUndefined()
  })

  it("has no hint when the dependency carries none", () => {
    expect(retryAfter(new Unavailable({ dependency: "emr" }))).toBeUndefined()
  })
})

describe("retry-after", () => {
  const answer = (headers: Record<string, string>): Answer => ({
    status: 503,
    url: "https://emr.example",
    headers,
    body: ""
  })

  it("prefers the header the server sent", () => {
    expect(waitOf(answer({ "retry-after": " 12 " }), 500)).toBe(12_000)
  })

  it("falls back when the header is absent", () => {
    expect(waitOf(answer({}), 500)).toBe(500)
  })

  it("falls back when the header is not a delay", () => {
    expect(waitOf(answer({ "retry-after": "Wed, 21 Oct 2015" }), 500)).toBe(500)
  })
})

describe("json bodies", () => {
  it("reads a document", () => {
    expect(jsonOf("{\"a\":1}")).toEqual({ a: 1 })
  })

  it("refuses to guess at text that is not json", () => {
    expect(jsonOf("<html>")).toBeUndefined()
  })
})
