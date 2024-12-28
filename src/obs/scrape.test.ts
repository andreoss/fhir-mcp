import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, TestContext } from "effect"
import { statusOf } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { capture } from "./sink.js"
import { layer as telemetry } from "./telemetry.js"
import { Metrics, layer as metrics } from "./metrics.js"
import type { Meter } from "./metrics.js"
import { RESTRICTED, digest, exposition, load, scrape } from "./scrape.js"
import type { Access } from "./scrape.js"

const loaded = (env: Record<string, string | undefined>) => Effect.runSyncExit(load(env))

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const failure = <A>(exit: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected failure")
}

const served = (
  access: Access,
  presented: string | undefined,
  fill: (meter: Meter) => Effect.Effect<void> = () => Effect.void
) => {
  const held = capture()
  const built = Layer.provide(metrics(), Layer.provide(telemetry(), held.layer))
  return Effect.runPromiseExit(
    Metrics.pipe(
      Effect.flatMap((meter) => Effect.zipRight(fill(meter), scrape(access, presented))),
      Effect.provide(built),
      Effect.provide(TestContext.TestContext)
    )
  )
}

describe("scrape access", () => {
  it("is restricted when nothing is configured", () => {
    expect(value(loaded({}))).toEqual(RESTRICTED)
    expect(value(loaded({})).exposed).toBe(false)
  })

  it("ignores keys it does not own", () => {
    expect(value(loaded({ UNRELATED: "on" }))).toEqual(RESTRICTED)
  })

  it("treats an empty value as unset", () => {
    expect(value(loaded({ FHIR_METRICS_EXPOSE: "   " }))).toEqual(RESTRICTED)
  })

  it("refuses to serve an unconfigured build", async () => {
    const exit = await served(value(loaded({})), undefined)
    expect(failure(exit)._tag).toBe("Forbidden")
    expect(statusOf(failure(exit))).toBe(403)
  })

  it("refuses an unconfigured build even when a token is presented", async () => {
    const exit = await served(value(loaded({})), "any-token")
    expect(failure(exit)._tag).toBe("Forbidden")
  })

  it("rejects exposing the endpoint without a token", () => {
    const rejected = failure(loaded({ FHIR_METRICS_EXPOSE: "on" }))
    expect(rejected._tag).toBe("Rejected")
    expect(JSON.stringify(rejected)).toContain("FHIR_METRICS_TOKEN")
  })

  it("names the key when the choice is not one it knows", () => {
    expect(JSON.stringify(failure(loaded({ FHIR_METRICS_EXPOSE: "maybe" })))).toContain(
      "FHIR_METRICS_EXPOSE"
    )
  })

  it("holds the token as a digest, never as the token", () => {
    const access = value(loaded({ FHIR_METRICS_EXPOSE: "on", FHIR_METRICS_TOKEN: "scrape-secret" }))
    expect(access.exposed).toBe(true)
    expect(JSON.stringify(access)).not.toContain("scrape-secret")
    expect(access.digest).toHaveLength(64)
    expect(digest("scrape-secret")).toBe(access.digest)
  })

  it("serves when the presented token matches", async () => {
    const access = value(loaded({ FHIR_METRICS_EXPOSE: "on", FHIR_METRICS_TOKEN: "scrape-secret" }))
    const exit = await served(access, "scrape-secret", (meter) =>
      meter.record("search", "Patient", "success", 30)
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(value(exit)).toContain("fhir_op_total")
  })

  it("refuses a token that does not match", async () => {
    const access = value(loaded({ FHIR_METRICS_EXPOSE: "on", FHIR_METRICS_TOKEN: "scrape-secret" }))
    expect(failure(await served(access, "guess"))._tag).toBe("Forbidden")
  })

  it("refuses when no token is presented at all", async () => {
    const access = value(loaded({ FHIR_METRICS_EXPOSE: "on", FHIR_METRICS_TOKEN: "scrape-secret" }))
    expect(failure(await served(access, undefined))._tag).toBe("Forbidden")
  })
})

describe("scrape exposition", () => {
  const series = [
    {
      op: "search",
      type: "Patient",
      outcome: "success",
      count: 2,
      sum: 307,
      buckets: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2]
    },
    {
      op: "search",
      type: "Patient",
      outcome: "failure",
      count: 1,
      sum: 12,
      buckets: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1]
    }
  ]

  it("renders nothing when nothing was recorded", () => {
    expect(exposition([])).toBe("")
  })

  it("renders a counter per series", () => {
    const text = exposition(series)
    expect(text).toContain("# TYPE fhir_op_total counter")
    expect(text).toContain('fhir_op_total{op="search",type="Patient",outcome="success"} 2')
    expect(text).toContain('fhir_op_total{op="search",type="Patient",outcome="failure"} 1')
  })

  it("renders a failure as a failure", () => {
    expect(exposition(series)).toContain('fhir_op_failures_total{op="search",type="Patient"} 1')
  })

  it("renders latency as a histogram with a sum and a count", () => {
    const text = exposition(series)
    expect(text).toContain("# TYPE fhir_op_latency_ms histogram")
    expect(text).toContain('le="10"} 1')
    expect(text).toContain('le="+Inf"} 2')
    expect(text).toContain('fhir_op_latency_ms_sum{op="search",type="Patient",outcome="success"} 307')
    expect(text).toContain('fhir_op_latency_ms_count{op="search",type="Patient",outcome="success"} 2')
  })

  it("renders a missing bucket as none observed", () => {
    const text = exposition([
      { op: "export", type: "Patient", outcome: "success", count: 1, sum: 1, buckets: [1] }
    ])
    expect(text).toContain('le="5"} 1')
    expect(text).toContain('le="5000"} 0')
  })

  it("ends every line and the text with a newline", () => {
    const text = exposition(series)
    expect(text.endsWith("\n")).toBe(true)
    expect(text.split("\n").filter((line) => line.length > 0).every((line) => !line.includes("\r"))).toBe(true)
  })

  it("carries no protected data even when a label was smuggled", async () => {
    const access = value(loaded({ FHIR_METRICS_EXPOSE: "on", FHIR_METRICS_TOKEN: "scrape-secret" }))
    const exit = await served(access, "scrape-secret", (meter) =>
      meter.record("search", "Simpson", "success", 5)
    )
    const text = value(exit)
    expect(text).not.toContain("Simpson")
    expect(text).toContain('type="other"')
    expect(text).not.toContain("scrape-secret")
  })
})
