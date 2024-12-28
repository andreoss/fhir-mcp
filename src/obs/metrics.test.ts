import { describe, expect, it } from "vitest"
import { Effect, Layer, TestClock, TestContext } from "effect"
import { NotFound } from "../core/outcome.js"
import { capture } from "./sink.js"
import type { Event } from "./sink.js"
import { OPS, OTHER, layer as telemetry } from "./telemetry.js"
import { BUCKETS, Metrics, layer as metrics } from "./metrics.js"
import type { Meter, Series } from "./metrics.js"

const exercise = <A, E>(
  body: (meter: Meter) => Effect.Effect<A, E>
): Promise<{
  readonly exit: Awaited<ReturnType<typeof Effect.runPromiseExit<A, E>>>
  readonly seen: ReadonlyArray<Event>
  readonly series: ReadonlyArray<Series>
}> => {
  const held = capture()
  const built = Layer.provide(metrics(), Layer.provide(telemetry(), held.layer))
  const shot: Array<Series> = []
  return Effect.runPromiseExit(
    Metrics.pipe(
      Effect.flatMap((meter) =>
        Effect.tap(
          Effect.exit(body(meter)),
          () => Effect.map(meter.snapshot, (taken) => shot.push(...taken))
        )
      ),
      Effect.flatten,
      Effect.provide(built),
      Effect.provide(TestContext.TestContext)
    )
  ).then((exit) => ({ exit, seen: held.taken(), series: shot }))
}

const one = (series: ReadonlyArray<Series>, outcome: string): Series => {
  const found = series.find((entry) => entry.outcome === outcome)
  if (found === undefined) throw new Error(`no series with outcome ${outcome}`)
  return found
}

describe("metrics", () => {
  it("names the operations the backlog names", () => {
    expect([...OPS]).toEqual(["bundle", "export", "import", "reindex", "search"])
  })

  it("counts an operation with latency and outcome", async () => {
    const { series } = await exercise((meter) => meter.record("search", "Patient", "success", 30))
    expect(series).toHaveLength(1)
    expect(series[0]!.op).toBe("search")
    expect(series[0]!.type).toBe("Patient")
    expect(series[0]!.outcome).toBe("success")
    expect(series[0]!.count).toBe(1)
    expect(series[0]!.sum).toBe(30)
  })

  it("holds a series for every named operation", async () => {
    const { series } = await exercise((meter) =>
      Effect.forEach(OPS, (op) => meter.record(op, "Patient", "success", 1))
    )
    expect(series.map((entry) => entry.op)).toEqual([...OPS])
  })

  it("adds latency into cumulative buckets", async () => {
    const { series } = await exercise((meter) =>
      Effect.zipRight(
        meter.record("search", "Patient", "success", 7),
        meter.record("search", "Patient", "success", 300)
      )
    )
    const found = series[0]!
    expect(found.count).toBe(2)
    expect(found.sum).toBe(307)
    expect(found.buckets[BUCKETS.indexOf(5)]).toBe(0)
    expect(found.buckets[BUCKETS.indexOf(10)]).toBe(1)
    expect(found.buckets[BUCKETS.indexOf(500)]).toBe(2)
  })

  it("counts a failure as a failure and never as a success", async () => {
    const { series, exit } = await exercise((meter) =>
      meter.time("search", "Patient", Effect.fail(new NotFound({ type: "Patient", id: "p1" })))
    )
    expect(exit._tag).toBe("Failure")
    expect(one(series, "failure").count).toBe(1)
    expect(series.find((entry) => entry.outcome === "success")).toBeUndefined()
  })

  it("propagates the failure of a timed effect unchanged", async () => {
    const { exit } = await exercise((meter) =>
      meter.time("import", "Patient", Effect.fail(new NotFound({ type: "Patient", id: "p1" })))
    )
    if (exit._tag !== "Failure") throw new Error("expected a failure")
    expect(String(exit.cause)).toContain("NotFound")
  })

  it("propagates the value of a timed effect unchanged", async () => {
    const { exit, series } = await exercise((meter) =>
      meter.time("export", "Patient", Effect.succeed(42))
    )
    expect(exit._tag).toBe("Success")
    expect(one(series, "success").count).toBe(1)
  })

  it("counts a defect as a failure and still propagates it", async () => {
    const { exit, series } = await exercise((meter) =>
      meter.time("reindex", "Patient", Effect.die(new Error("engine lost")))
    )
    expect(exit._tag).toBe("Failure")
    expect(one(series, "failure").count).toBe(1)
  })

  it("records the elapsed time of a timed effect", async () => {
    const { series } = await exercise((meter) =>
      meter.time("bundle", "Patient", TestClock.adjust("40 millis"))
    )
    expect(one(series, "success").sum).toBe(40)
  })

  it("refuses a resource id as a label", async () => {
    const { series } = await exercise((meter) => meter.record("search", "p1", "success", 1))
    expect(series[0]!.type).toBe(OTHER)
    expect(JSON.stringify(series)).not.toContain("p1")
  })

  it("refuses a search value as a label", async () => {
    const { series, seen } = await exercise((meter) =>
      meter.record("search", "Simpson", "success", 1)
    )
    expect(series[0]!.type).toBe(OTHER)
    expect(JSON.stringify(series)).not.toContain("Simpson")
    expect(JSON.stringify(seen)).not.toContain("Simpson")
  })

  it("refuses an operation name it does not know", async () => {
    const { series } = await exercise((meter) => meter.record("exfiltrate", "Patient", "success", 1))
    expect(series[0]!.op).toBe(OTHER)
  })

  it("emits a telemetry record beside the counter", async () => {
    const { seen } = await exercise((meter) => meter.record("search", "Patient", "failure", 5))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe("op")
    expect(seen[0]!.dims).toEqual({ op: "search", type: "Patient", outcome: "failure" })
  })

  it("keeps counting when telemetry is rate limited", async () => {
    const held = capture()
    const built = Layer.provide(metrics(), Layer.provide(telemetry({ burst: 3, perSecond: 3 }), held.layer))
    const series = await Effect.runPromise(
      Metrics.pipe(
        Effect.flatMap((meter) =>
          Effect.zipRight(
            Effect.forEach(Array.from({ length: 40 }, (_, i) => i), () =>
              meter.record("search", "Patient", "success", 1)
            ),
            meter.snapshot
          )
        ),
        Effect.provide(built),
        Effect.provide(TestContext.TestContext)
      )
    )
    expect(held.taken()).toHaveLength(3)
    expect(series[0]!.count).toBe(40)
  })

  it("never records a negative latency when a clock moves backwards", async () => {
    const { series } = await exercise((meter) => meter.record("search", "Patient", "success", -5))
    expect(series[0]!.sum).toBe(0)
  })

  it("orders a snapshot the same way every time", async () => {
    const { series } = await exercise((meter) =>
      Effect.zipRight(
        Effect.zipRight(
          meter.record("search", "Patient", "success", 1),
          meter.record("bundle", "Observation", "failure", 1)
        ),
        meter.record("bundle", "Encounter", "success", 1)
      )
    )
    expect(series.map((entry) => `${entry.op}/${entry.type}`)).toEqual([
      "bundle/Encounter",
      "bundle/Observation",
      "search/Patient"
    ])
  })
})
