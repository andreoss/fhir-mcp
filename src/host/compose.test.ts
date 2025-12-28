import { describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Grant, Journal } from "../agent/write.js"
import { FhirOperations } from "../agent/tools.js"
import { FhirEngine } from "../core/engine.js"
import { Versions } from "../core/interactions.js"
import type { Failure } from "../core/outcome.js"
import { Jobs } from "../jobs/service.js"
import type { Status } from "../jobs/service.js"
import { Metrics } from "../obs/metrics.js"
import { TerminologyPort } from "../terminology/port.js"
import { open } from "../trail/store.js"
import { retryAfter } from "../persist/pool.js"
import { STORE, connect, grantOf, journalToErrors, trailed, wiring } from "./compose.js"
import type { Opening, Wiring } from "./compose.js"
import type { Config } from "../config/config.js"

const config = (allowWrite: boolean): Config => ({
  transport: "stdio",
  http: { host: "127.0.0.1", port: 8080, origins: [] },
  store: { path: ":memory:" },
  scopes: [],
  allowWrite,
  terminologyDir: undefined,
  logLevel: "info",
  trail: { path: ":memory:", key: "", retentionMs: 0 }
})

const grantIn = (allowWrite: boolean) =>
  Effect.runSync(Effect.provide(Grant, grantOf(config(allowWrite), "c1")))

describe("composition", () => {
  it("withholds the write capability unless the configuration grants it", () => {
    expect(grantIn(false).write).toBe(false)
  })

  it("passes the write capability through when the configuration grants it", () => {
    expect(grantIn(true).write).toBe(true)
  })

  it("carries a correlation id into the grant", () => {
    expect(grantIn(false).correlation).toBe("c1")
  })

  it("never puts a token in the grant it was not given", () => {
    expect(grantIn(true).token).toBeUndefined()
  })

  it("writes an audit entry to the error stream, never the answer stream", async () => {
    const written: Array<string> = []
    const original = process.stderr.write.bind(process.stderr)
    const answer: Array<string> = []
    const stdout = process.stdout.write.bind(process.stdout)
    process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true }) as never
    process.stdout.write = ((chunk: string) => { answer.push(String(chunk)); return true }) as never
    try {
      await Effect.runPromise(
        Effect.flatMap(Effect.provide(
          Effect.gen(function* () {
            const { Journal } = yield* Effect.promise(() => import("../agent/write.js"))
            return yield* Journal
          }),
          journalToErrors
        ), (ledger) => ledger.note({
          at: "t",
          correlation: "c1",
          actor: "anonymous",
          tool: "create",
          interaction: "create",
          outcome: "success"
        }))
      )
    } finally {
      process.stderr.write = original
      process.stdout.write = stdout
    }
    expect(written.join("")).toContain("create")
    expect(answer).toEqual([])
  })

  it("builds every layer the surface requires", async () => {
    const built = await Effect.runPromise(
      Effect.scoped(Layer.build(Layer.orDie(wiring(config(false)))))
    )
    expect(built).toBeDefined()
  })

  it("holds a run of audit entries in a durable trail that verifies", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "trail-")), "trail.duckdb")
    const held: Config = {
      ...config(false),
      trail: { path, key: "k-1", retentionMs: 0 }
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(Layer.build(Layer.orDie(trailed(held))), (context) =>
          Context.get(context, Journal).note({
            at: "t",
            correlation: "c1",
            actor: "anonymous",
            tool: "create",
            interaction: "create",
            outcome: "success",
            type: "Patient",
            id: "p1"
          })
        )
      )
    )
    const report = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(open(path), (trail) => trail.verify("k-1")))
    )
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(1)
    expect(report.head).toBe(1)
  })

  it("empties a durable trail of entries older than the retention it was given", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "trail-")), "trail.duckdb")
    const first = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(open(path), (trail) => trail.append({
        actor: "anonymous",
        action: "create",
        resource: "Patient/p1",
        outcome: "success",
        correlation: "c0"
      })))
    )
    expect(first.seq).toBe(1)
    const held: Config = {
      ...config(false),
      trail: { path, key: "k-1", retentionMs: 1 }
    }
    await Effect.runPromise(Effect.scoped(Layer.build(Layer.orDie(trailed(held)))))
    const lines = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(open(path), (trail) => trail.lines))
    )
    expect(lines).toEqual([])
  })
})

const vance = {
  resourceType: "Patient",
  id: "p1",
  name: [{ family: "Vance", given: ["Ada"] }],
  gender: "female"
}

const inside = <A>(
  held: Config,
  use: (context: Context.Context<Wiring>) => Effect.Effect<A, unknown>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(Layer.orDie(wiring(held))), use)
    ) as Effect.Effect<A>
  )

const settled = (
  desk: { readonly status: (id: string) => Effect.Effect<Status, Failure> },
  id: string,
  tries: number
): Effect.Effect<Status, Failure> =>
  Effect.gen(function* () {
    const seen = yield* desk.status(id)
    const open = seen.state === "queued" || seen.state === "running"
    if (!open || tries === 0) return seen
    yield* Effect.sleep("100 millis")
    return yield* settled(desk, id, tries - 1)
  })

describe("what the composition root binds", () => {
  it("serves the engine that understands a modifier, not the store that cannot", async () => {
    const found = await inside(config(true), (context) =>
      Effect.gen(function* () {
        yield* Context.get(context, Versions).insertVersion({
          type: "Patient",
          id: "p1",
          versionId: 1,
          lastUpdated: new Date().toISOString(),
          deleted: false,
          body: vance
        })
        return yield* Context.get(context, FhirEngine).search({
          type: "Patient",
          parameters: [["family:contains", "anc"]]
        })
      }))
    expect((found.entry ?? []).map((one) => one.resource.id)).toEqual(["p1"])
  })

  it("supplies a terminology port a caller can reach", async () => {
    const found = await inside(config(false), (context) =>
      Context.get(context, TerminologyPort).lookup({
        system: "http://example/absent",
        code: "a"
      }))
    expect(found._tag).toBe("Unsupplied")
  })

  it("serves a job desk that takes a submission and reports it back", async () => {
    const seen = await inside(config(true), (context) =>
      Effect.gen(function* () {
        const desk = Context.get(context, Jobs)
        const ticket = yield* desk.submit(
          "reindex",
          JSON.stringify({ type: "Patient" })
        )
        return { ticket, status: yield* desk.status(ticket.id) }
      }))
    expect(seen.ticket.location).toBe(`/jobs/${seen.status.id}`)
    expect(seen.status.kind).toBe("reindex")
    expect(seen.status.total).toBe(1)
  })

  it("runs a job submitted through the composition root to its end", async () => {
    const seen = await inside(config(true), (context) =>
      Effect.gen(function* () {
        const desk = Context.get(context, Jobs)
        const ticket = yield* desk.submit(
          "reindex",
          JSON.stringify({ type: "Patient" })
        )
        return yield* settled(desk, ticket.id, 60)
      }))
    expect(seen.state).toBe("done")
    expect(seen.done).toBe(1)
  })

  it("serves an operations port that answers an operation by name", async () => {
    const found = await inside(config(true), (context) =>
      Effect.gen(function* () {
        yield* Context.get(context, Versions).insertVersion({
          type: "Patient",
          id: "p1",
          versionId: 1,
          lastUpdated: new Date().toISOString(),
          deleted: false,
          body: vance
        })
        yield* Context.get(context, Versions).insertVersion({
          type: "Observation",
          id: "o1",
          versionId: 1,
          lastUpdated: new Date().toISOString(),
          deleted: false,
          body: { resourceType: "Observation", id: "o1", subject: { reference: "Patient/p1" } }
        })
        return yield* Context.get(context, FhirOperations).invoke({
          name: "$everything",
          type: "Patient",
          id: "p1",
          parameters: []
        })
      }))
    expect(found.type).toBe("searchset")
    expect((found.entry ?? []).map((one) => one.resource.id).sort()).toEqual(["o1", "p1"])
  })

  it("serves an operations port that refuses a patient it cannot reach", async () => {
    const held: Config = { ...config(true), scopes: ["patient:p2/Observation.read"] }
    await expect(
      inside(held, (context) =>
        Context.get(context, FhirOperations).invoke({
          name: "$everything",
          type: "Patient",
          id: "p1",
          parameters: []
        }))
    ).rejects.toThrow()
  })

  it("supplies a meter so the served path is measured", async () => {
    const seen = await inside(config(false), (context) =>
      Effect.gen(function* () {
        const meter = Context.get(context, Metrics)
        yield* meter.record("search", "Patient", "success", 4)
        return yield* meter.snapshot
      }))
    expect(seen.map((one) => one.op)).toEqual(["search"])
  })

  it("bounds how long it waits for the store and what it says to retry", () => {
    expect(STORE.size).toBe(1)
    expect(STORE.waitMs).toBeGreaterThan(0)
    expect(STORE.retryAfterMs).toBeGreaterThan(0)
  })

  it("answers through the store connection it took from the pool", async () => {
    const rows = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(connect(":memory:"), (connection) =>
          Effect.promise(async () => {
            const reader = await connection.runAndReadAll("select 1 as n")
            return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
          })
        )
      )
    )
    expect(Number(rows[0]?.["n"])).toBe(1)
  })

  it("refuses a store that never opens, and says when to retry", async () => {
    const hanging: Opening = () => Effect.never
    const quick = { size: 1, reserved: 0, waitMs: 5, retryAfterMs: 7 }
    const failed = await Effect.runPromise(
      Effect.exit(Effect.scoped(connect(":memory:", quick, hanging)))
    )
    if (!Exit.isFailure(failed) || failed.cause._tag !== "Fail") {
      throw new Error("expected a failure")
    }
    expect(failed.cause.error._tag).toBe("Unavailable")
    expect(retryAfter(failed.cause.error)).toBe(7)
  })
})
