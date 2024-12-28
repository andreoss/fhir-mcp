import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { TelemetrySink, capture, errors, line, stream } from "./sink.js"

const event = {
  at: "2026-01-01T00:00:00.000Z",
  level: "info" as const,
  kind: "op",
  correlation: "req-1",
  dims: { op: "search", outcome: "success" }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("sink", () => {
  it("captures what was emitted", async () => {
    const held = capture()
    await Effect.runPromise(
      TelemetrySink.pipe(
        Effect.flatMap((sink) => sink.emit(event)),
        Effect.provide(held.layer)
      )
    )
    expect(held.taken()).toEqual([event])
  })

  it("renders only the fields a record declares", () => {
    const rendered = JSON.parse(line({ ...event, token: "secret-bearer" } as never))
    expect(Object.keys(rendered).sort()).toEqual(["at", "correlation", "dims", "kind", "level"])
    expect(line({ ...event, token: "secret-bearer" } as never)).not.toContain("secret-bearer")
  })

  it("writes one newline-terminated record", async () => {
    const written: Array<string> = []
    await Effect.runPromise(
      TelemetrySink.pipe(
        Effect.flatMap((sink) => sink.emit(event)),
        Effect.provide(stream((text) => written.push(text)))
      )
    )
    expect(written).toHaveLength(1)
    expect(written[0]!.endsWith("\n")).toBe(true)
    expect(JSON.parse(written[0]!.trim()).kind).toBe("op")
  })

  it("writes to the error stream and never to the answer stream", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const out = vi.spyOn(process.stdout, "write")
    const before = out.mock.calls.length
    await Effect.runPromise(
      TelemetrySink.pipe(Effect.flatMap((sink) => sink.emit(event)), Effect.provide(errors))
    )
    expect(err).toHaveBeenCalledTimes(1)
    expect(out.mock.calls.length).toBe(before)
    expect(String(err.mock.calls[0]![0])).toContain("\"kind\":\"op\"")
  })
})
