import { describe, expect, it } from "vitest"
import { Effect, Layer, TestClock, TestContext } from "effect"
import { capture } from "./sink.js"
import type { Event } from "./sink.js"
import { edge } from "./correlation.js"
import { KINDS, OTHER, Telemetry, UNSET, layer, normalize } from "./telemetry.js"
import type { Emitter, Limit } from "./telemetry.js"

const exercise = <A>(
  body: (telemetry: Emitter) => Effect.Effect<A>,
  limit?: Limit
): Promise<{ readonly value: A; readonly seen: ReadonlyArray<Event> }> => {
  const held = capture()
  const built = Layer.provide(limit === undefined ? layer() : layer(limit), held.layer)
  return Effect.runPromise(
    Telemetry.pipe(
      Effect.flatMap(body),
      Effect.provide(built),
      Effect.provide(TestContext.TestContext)
    )
  ).then((value) => ({ value, seen: held.taken() }))
}

const dimsOf = (seen: ReadonlyArray<Event>) => seen.map((event) => event.dims)

describe("telemetry dimensions", () => {
  it("keeps the declared dimension set whatever a caller passes", async () => {
    const { seen } = await exercise((telemetry) =>
      Effect.zipRight(
        telemetry.emit("op", { op: "search", type: "Patient", outcome: "success" }),
        telemetry.emit("op", { op: "export" })
      )
    )
    const keys = dimsOf(seen).map((dims) => Object.keys(dims))
    expect(keys[0]).toEqual(Object.keys(KINDS.op))
    expect(keys[1]).toEqual(Object.keys(KINDS.op))
  })

  it("fills a dimension a caller left out", () => {
    expect(normalize("op", { op: "search" })).toEqual({
      op: "search",
      type: UNSET,
      outcome: UNSET
    })
  })

  it("drops a dimension the kind does not declare", async () => {
    const { seen } = await exercise((telemetry) =>
      telemetry.emit("op", { op: "search", family: "Simpson", id: "p1" })
    )
    expect(Object.keys(seen[0]!.dims)).toEqual(Object.keys(KINDS.op))
    expect(JSON.stringify(seen)).not.toContain("Simpson")
    expect(JSON.stringify(seen)).not.toContain("p1")
  })

  it("refuses a resource id smuggled under a declared dimension", async () => {
    const { seen } = await exercise((telemetry) =>
      telemetry.emit("op", { op: "search", type: "Patient/p1", outcome: "success" })
    )
    expect(seen[0]!.dims["type"]).toBe(OTHER)
    expect(JSON.stringify(seen)).not.toContain("p1")
  })

  it("refuses a search value that looks like a resource type", async () => {
    const { seen } = await exercise((telemetry) =>
      telemetry.emit("op", { op: "search", type: "Simpson", outcome: "success" })
    )
    expect(seen[0]!.dims["type"]).toBe(OTHER)
    expect(JSON.stringify(seen)).not.toContain("Simpson")
  })

  it("refuses an operation name it does not know", async () => {
    const { seen } = await exercise((telemetry) => telemetry.emit("op", { op: "drop-everything" }))
    expect(seen[0]!.dims["op"]).toBe(OTHER)
  })

  it("declares a different fixed set for a different kind", async () => {
    const { seen } = await exercise((telemetry) =>
      telemetry.emit("job", { job: "export", outcome: "failure" })
    )
    expect(Object.keys(seen[0]!.dims)).toEqual(Object.keys(KINDS.job))
    expect(seen[0]!.dims["outcome"]).toBe("failure")
  })

  it("never lets a dimension value carry punctuation from a caller", async () => {
    const { seen } = await exercise((telemetry) =>
      telemetry.emit("op", { op: 'search" injected="yes' })
    )
    expect(seen[0]!.dims["op"]).toBe(OTHER)
  })
})

describe("telemetry correlation", () => {
  it("stamps the correlation id of the flow", async () => {
    const held = capture()
    const built = Layer.provide(layer(), held.layer)
    await Effect.runPromise(
      edge(
        Telemetry.pipe(Effect.flatMap((telemetry) => telemetry.emit("op", { op: "search" }))),
        "req-t"
      ).pipe(Effect.provide(built), Effect.provide(TestContext.TestContext))
    )
    expect(held.taken()[0]!.correlation).toBe("req-t")
  })

  it("says there is no correlation outside a flow", async () => {
    const { seen } = await exercise((telemetry) => telemetry.emit("op", { op: "search" }))
    expect(seen[0]!.correlation).toBe("none")
  })
})

describe("telemetry rate limit", () => {
  const flood = (telemetry: Emitter, count: number, op: string) =>
    Effect.forEach(Array.from({ length: count }, (_, i) => i), () =>
      telemetry.emit("op", { op, type: "Patient", outcome: "success" })
    )

  it("stops a hot loop from flooding the sink", async () => {
    const { seen } = await exercise(
      (telemetry) => flood(telemetry, 500, "search"),
      { burst: 10, perSecond: 10 }
    )
    expect(seen).toHaveLength(10)
  })

  it("counts what it dropped", async () => {
    const { value } = await exercise(
      (telemetry) => Effect.zipRight(flood(telemetry, 50, "search"), telemetry.dropped),
      { burst: 10, perSecond: 10 }
    )
    expect(value).toBe(40)
  })

  it("lets emission through again once the window refills", async () => {
    const { seen } = await exercise(
      (telemetry) =>
        Effect.zipRight(
          Effect.zipRight(flood(telemetry, 50, "search"), TestClock.adjust("1 seconds")),
          flood(telemetry, 50, "search")
        ),
      { burst: 10, perSecond: 10 }
    )
    expect(seen).toHaveLength(20)
  })

  it("limits each series on its own", async () => {
    const { seen } = await exercise(
      (telemetry) => Effect.zipRight(flood(telemetry, 50, "search"), flood(telemetry, 50, "export")),
      { burst: 10, perSecond: 10 }
    )
    expect(seen.filter((event) => event.dims["op"] === "search")).toHaveLength(10)
    expect(seen.filter((event) => event.dims["op"] === "export")).toHaveLength(10)
  })
})
