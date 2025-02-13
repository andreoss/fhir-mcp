import { describe, expect, it, vi } from "vitest"
import { Effect, Ref, TestClock, TestContext } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Rules, Versions, create, remove } from "../core/interactions.js"
import { defaults } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { queueOn } from "../jobs/queue.js"
import type { Durable } from "../jobs/queue.js"
import { desk } from "../jobs/service.js"
import type { Desk } from "../jobs/service.js"
import { start } from "../jobs/worker.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import { depotOn } from "./depot.js"
import type { Depot } from "./depot.js"
import { handlers, report } from "./bulk.js"

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const SHIFT = {
  slots: 1,
  leaseMs: 600_000,
  heartbeatMs: 60_000,
  idleMs: 500,
  retryInMs: 1_000,
  graceMs: 1_000,
  ceilings: {}
}

interface Bench {
  readonly store: Versioned
  readonly depot: Depot
  readonly queue: Durable
  readonly desk: (given: Depot) => Desk
}

const turn = Effect.promise(
  () => new Promise<void>((done) => setImmediate(done))
)

const settle = (check: Effect.Effect<boolean, Failure>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 200; round++) {
      for (let spin = 0; spin < 16; spin++) {
        yield* turn
        if (yield* check) return true
      }
      yield* TestClock.adjust(250)
    }
    return false
  })

const bench = <A>(
  work: (held: Bench) => Effect.Effect<A, Failure>
): Promise<A> =>
  Effect.runPromise(
    Effect.promise(async () => {
      const instance = await DuckDBInstance.create(":memory:")
      return await instance.connect()
    }).pipe(
      Effect.flatMap((connection: DuckDBConnection) =>
        Effect.gen(function* () {
          const store = yield* versionedOn(connection)
          const depot = yield* depotOn(connection)
          const queue = yield* queueOn(connection)
          return yield* work({
            store,
            depot,
            queue,
            desk: (given) => desk(queue, handlers(store, given))
          })
        })
      ),
      Effect.provide(TestContext.TestContext)
    )
  )

const broke = <A>(work: (held: Bench) => Effect.Effect<A, Failure>) =>
  bench((held) =>
    Effect.matchEffect(work(held), {
      onFailure: (failure: Failure) => Effect.succeed(failure._tag),
      onSuccess: () => Effect.succeed("no failure")
    })
  )

const patient = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family }],
  gender: "female"
})

const observation = (id: string, subject: string): FhirResource => ({
  resourceType: "Observation",
  id,
  status: "final",
  code: { coding: [{ code: "8867-4" }] },
  subject: { reference: `Patient/${subject}` }
})

const seed = (store: Versioned, body: FhirResource) =>
  create(body.resourceType, body).pipe(
    Effect.provideService(Versions, store),
    Effect.provideService(Rules, defaults)
  )

const world = (store: Versioned) =>
  Effect.gen(function* () {
    for (const one of ["p1", "p2", "p3", "p4", "p5"]) {
      yield* seed(store, patient(one, `Fam-${one}`))
    }
    yield* seed(store, observation("o1", "p1"))
    yield* seed(store, observation("o2", "p1"))
    yield* seed(store, observation("o3", "p2"))
    yield* seed(store, observation("o4", "p3"))
  })

const flaky = (depot: Depot, at: Ref.Ref<number>): Depot => ({
  ...depot,
  put: (path: string, lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const left = yield* Ref.updateAndGet(at, (held) => held - 1)
      yield* depot.put(path, lines)
      if (left === 0) {
        return yield* Effect.fail(new Unavailable({ dependency: "sink" }))
      }
    })
})

const harvest = (depot: Depot, job: string, container = "export") =>
  Effect.gen(function* () {
    const sheets = yield* depot.list(`${container}/${job}/`)
    const out: Array<FhirResource> = []
    for (const sheet of sheets) {
      if (sheet.path.endsWith("error.ndjson")) continue
      const lines = yield* depot.get(sheet.path)
      for (const line of lines) out.push(JSON.parse(line) as FhirResource)
    }
    return out
  })

const worked = (held: Bench, given: Depot, request: string) =>
  Effect.gen(function* () {
    const counter = held.desk(given)
    const ticket = yield* counter.submit("export", request)
    const worker = yield* start(held.queue, handlers(held.store, given), SHIFT)
    const done = yield* settle(
      Effect.map(held.queue.poll(ticket.id), (job) => job.pending === 0)
    )
    yield* worker.stop
    expect(done).toBe(true)
    return ticket.id
  })

const ask = (given: Record<string, unknown>) =>
  JSON.stringify({ scope: { kind: "system" }, chunk: 2, ...given })

describe("export splitting", () => {
  it("splits a system export into a unit per type and chunk", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const cuts = yield* handlers(held.store, held.depot)
          .get("export")!
          .split(ask({}))
        expect(cuts.length).toBe(7)
        const seen = cuts.map(
          (cut) => (JSON.parse(cut) as { type: string }).type
        )
        expect(seen.filter((one) => one === "Patient").length).toBe(3)
        expect(seen.filter((one) => one === "Observation").length).toBe(2)
        expect(seen.filter((one) => one === "Condition").length).toBe(1)
      })
    ))

  it("splits an export of a type nothing matches into one empty unit", () =>
    bench((held) =>
      Effect.gen(function* () {
        const cuts = yield* handlers(held.store, held.depot)
          .get("export")!
          .split(ask({ _type: ["Patient"] }))
        expect(cuts.length).toBe(1)
        expect((JSON.parse(cuts[0] ?? "{}") as { ids: [] }).ids).toEqual([])
      })
    ))

  it("refuses an output format that is not ndjson", () =>
    expect(
      broke((held) =>
        held
          .desk(held.depot)
          .submit("export", ask({ _outputFormat: "application/fhir+json" }))
      )
    ).resolves.toBe("Rejected"))

  it("refuses a type filter on a type outside the selection", () =>
    expect(
      broke((held) =>
        held
          .desk(held.depot)
          .submit(
            "export",
            ask({ _type: ["Patient"], _typeFilter: ["Observation?status=final"] })
          )
      )
    ).resolves.toBe("Rejected"))
})

describe("system export", () => {
  it("writes every matching resource exactly once across its files", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const job = yield* worked(held, held.depot, ask({}))
        const found = yield* harvest(held.depot, job)
        const ids = found.map((one) => `${one.resourceType}/${one.id}`).sort()
        expect(ids).toEqual([
          "Observation/o1",
          "Observation/o2",
          "Observation/o3",
          "Observation/o4",
          "Patient/p1",
          "Patient/p2",
          "Patient/p3",
          "Patient/p4",
          "Patient/p5"
        ])
        expect(new Set(ids).size).toBe(ids.length)
      })
    ))

  it("covers every resource once even when a unit is retried", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const at = yield* Ref.make(3)
        const job = yield* worked(held, flaky(held.depot, at), ask({}))
        const found = yield* harvest(held.depot, job)
        const ids = found.map((one) => `${one.resourceType}/${one.id}`)
        expect(ids.length).toBe(9)
        expect(new Set(ids).size).toBe(9)
        expect([...new Set(ids)].sort()).toEqual([
          "Observation/o1",
          "Observation/o2",
          "Observation/o3",
          "Observation/o4",
          "Patient/p1",
          "Patient/p2",
          "Patient/p3",
          "Patient/p4",
          "Patient/p5"
        ])
        const units = yield* held.queue.inspect(job)
        expect(units.filter((one) => one.attempts > 1).length).toBe(1)
        expect(units.every((one) => one.state === "done")).toBe(true)
      })
    ))

  it("holds the window a since and a till name", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* seed(held.store, patient("p1", "Early"))
        const first = yield* held.store.current("Patient", "p1")
        yield* seed(held.store, patient("p2", "Late"))
        const cut = first?.lastUpdated ?? ""
        const job = yield* worked(
          held,
          held.depot,
          ask({ _type: ["Patient"], _since: cut, _till: "2999-01-01" })
        )
        const found = yield* harvest(held.depot, job)
        expect(found.map((one) => one.id)).toEqual(["p1", "p2"])
        const later = yield* worked(
          held,
          held.depot,
          ask({ _type: ["Patient"], _till: cut })
        )
        expect((yield* harvest(held.depot, later)).length).toBe(0)
      })
    ))

  it("keeps to the types and the filter it was asked for", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const job = yield* worked(
          held,
          held.depot,
          ask({
            _type: ["Observation"],
            _typeFilter: ["Observation?subject=Patient/p1"]
          })
        )
        const found = yield* harvest(held.depot, job)
        expect(found.map((one) => one.id).sort()).toEqual(["o1", "o2"])
      })
    ))

  it("places its files in the container it was given", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* seed(held.store, patient("p1", "Vance"))
        const job = yield* worked(
          held,
          held.depot,
          ask({ _type: ["Patient"], _container: "vault" })
        )
        const sheets = yield* held.depot.list(`vault/${job}/`)
        expect(sheets.map((one) => one.path)).toEqual([
          `vault/${job}/Patient-0.ndjson`
        ])
        expect(sheets[0]?.rows).toBe(1)
      })
    ))
})

describe("scoped export", () => {
  it("exports one patient and what belongs to that patient", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const job = yield* worked(
          held,
          held.depot,
          JSON.stringify({ scope: { kind: "patient", ids: ["p1"] }, chunk: 5 })
        )
        const found = yield* harvest(held.depot, job)
        expect(found.map((one) => `${one.resourceType}/${one.id}`).sort()).toEqual(
          ["Observation/o1", "Observation/o2", "Patient/p1"]
        )
      })
    ))

  it("exports the members a group names", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const job = yield* worked(
          held,
          held.depot,
          JSON.stringify({
            scope: { kind: "group", group: "g1", ids: ["p2", "p3"] },
            chunk: 5
          })
        )
        const found = yield* harvest(held.depot, job)
        expect(found.map((one) => `${one.resourceType}/${one.id}`).sort()).toEqual(
          ["Observation/o3", "Observation/o4", "Patient/p2", "Patient/p3"]
        )
      })
    ))
})

describe("anonymized export", () => {
  const rules = {
    location: "conf/anon.json",
    rules: [
      { path: "name.family", act: "redact" },
      { path: "gender", act: "mask" }
    ]
  }

  it("never writes a redacted field into any output file", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const job = yield* worked(held, held.depot, ask({ rules }))
        const sheets = yield* held.depot.list(`export/${job}/`)
        expect(sheets.length).toBeGreaterThan(0)
        for (const sheet of sheets) {
          const lines = yield* held.depot.get(sheet.path)
          for (const line of lines) {
            expect(line).not.toContain("Fam-")
            expect(line).not.toContain("female")
          }
        }
        const found = yield* harvest(held.depot, job)
        const one = found.find((held) => held.resourceType === "Patient")
        expect(one?.["name"]).toEqual([{}])
        expect(one?.["gender"]).toBe("masked")
      })
    ))

  it("records the configuration and its etag in the job record", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const job = yield* worked(held, held.depot, ask({ rules }))
        const held0 = yield* held.depot.noted(job)
        expect(held0?.location).toBe("conf/anon.json")
        expect(held0?.etag).toMatch(/^W\/"[0-9a-f]{12}"$/)
        const account = yield* report(held.desk(held.depot), held.depot, job)
        expect(account.rules).toEqual({
          location: "conf/anon.json",
          etag: held0?.etag
        })
      })
    ))
})

describe("export progress and failures", () => {
  it("itemizes what failed and why in a failure file", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const counter = held.desk(held.depot)
        const ticket = yield* counter.submit("export", ask({ _type: ["Patient"] }))
        yield* remove("Patient", "p3", "hard").pipe(
          Effect.provideService(Versions, held.store)
        )
        yield* remove("Patient", "p4").pipe(
          Effect.provideService(Versions, held.store)
        )
        const worker = yield* start(
          held.queue,
          handlers(held.store, held.depot),
          SHIFT
        )
        yield* settle(
          Effect.map(held.queue.poll(ticket.id), (job) => job.pending === 0)
        )
        yield* worker.stop
        const account = yield* report(counter, held.depot, ticket.id)
        expect(account.state).toBe("done")
        expect(account.progress.total).toBe(3)
        expect(account.progress.done).toBe(3)
        expect(account.error).toBe(`export/${ticket.id}/error.ndjson`)
        const lines = yield* held.depot.get(account.error ?? "")
        const said = lines.map(
          (line) =>
            (
              JSON.parse(line) as {
                issue: ReadonlyArray<{ diagnostics: string }>
              }
            ).issue[0]?.diagnostics
        )
        expect(said).toEqual([
          "Patient/p3 not found",
          "Patient/p4 deleted"
        ])
        expect(account.detail).toContain("3 written")
        expect(account.detail).toContain("2 failed")
      })
    ))

  it("reports no failure file for a job that lost nothing", () =>
    bench((held) =>
      Effect.gen(function* () {
        yield* world(held.store)
        const counter = held.desk(held.depot)
        const job = yield* worked(held, held.depot, ask({ _type: ["Patient"] }))
        const account = yield* report(counter, held.depot, job)
        expect(account.error).toBeUndefined()
        expect(account.kind).toBe("export")
        expect(account.progress.failed).toBe(0)
        expect(account.output.map((one) => one.rows)).toEqual([2, 2, 1])
      })
    ))
})
