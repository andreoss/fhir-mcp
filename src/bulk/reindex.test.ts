import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Rules, Versions, create, defaults } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import type { Failure } from "../core/outcome.js"
import { resume } from "../obs/correlation.js"
import { queueOn } from "../jobs/queue.js"
import type { Durable } from "../jobs/queue.js"
import { handlerOf } from "../jobs/types.js"
import type { Registry } from "../jobs/types.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import { depotOn } from "./depot.js"
import type { Depot } from "./depot.js"
import { handlers } from "./bulk.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

interface Bench {
  readonly store: Versioned
  readonly depot: Depot
  readonly queue: Durable
  readonly held: Registry
  readonly sql: (
    text: string
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>
}

const bench = <A>(
  work: (given: Bench) => Effect.Effect<A, Failure>
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
          const sql = (text: string) =>
            Effect.promise(async () => {
              const reader = await connection.runAndReadAll(text)
              return reader.getRowObjects() as ReadonlyArray<
                Record<string, unknown>
              >
            })
          return yield* work({
            store,
            depot,
            queue,
            sql,
            held: handlers(store, depot)
          })
        })
      )
    )
  )

const broke = <A>(work: (given: Bench) => Effect.Effect<A, Failure>) =>
  bench((given) =>
    Effect.matchEffect(work(given), {
      onFailure: (failure: Failure) => Effect.succeed(failure._tag),
      onSuccess: () => Effect.succeed("no failure")
    })
  )

const pump = (given: Bench, kind: string, request: string) =>
  Effect.gen(function* () {
    const handler = yield* handlerOf(given.held, kind)
    const payloads = yield* handler.split(request)
    const job = yield* given.queue.submit({
      kind,
      payloads,
      correlation: "c-1",
      maxAttempts: 3
    })
    while (true) {
      const unit = yield* given.queue.lease("w-1", [kind], 60_000)
      if (unit === undefined) return job
      yield* resume({ correlation: unit.correlation }, handler.run(unit))
      yield* given.queue.complete(unit)
    }
  })

const patient = (id: string): FhirResource => ({
  resourceType: "Patient",
  id,
  gender: "male",
  name: [{ family: `Fam-${id}` }]
})

const observation = (id: string): FhirResource => ({
  resourceType: "Observation",
  id,
  status: "final",
  code: { coding: [{ code: "8867-4" }] }
})

const seed = (store: Versioned, body: FhirResource) =>
  create(body.resourceType, body).pipe(
    Effect.provideService(Versions, store),
    Effect.provideService(Rules, defaults)
  )

const world = (store: Versioned) =>
  Effect.gen(function* () {
    for (const one of ["p1", "p2", "p3"]) yield* seed(store, patient(one))
    yield* seed(store, observation("o1"))
    yield* seed(store, observation("o2"))
  })

const scanned = (depot: Depot, job: string) =>
  Effect.map(depot.marks(job), (marks) =>
    marks.reduce((total, one) => total + one.scanned, 0)
  )

describe("reindex splitting", () => {
  it("refuses an id without the type that carries it", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "reindex"), (handler) =>
          handler.split(JSON.stringify({ id: "p1" }))
        )
      )
    ).resolves.toBe("Rejected"))

  it("refuses a type that is not served", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "reindex"), (handler) =>
          handler.split(JSON.stringify({ type: "Practitioner" }))
        )
      )
    ).resolves.toBe("Rejected"))

  it("splits one unit per chunk of the target", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "reindex")
        const cuts = yield* handler.split(JSON.stringify({ chunk: 2 }))
        expect(cuts.map((cut) => JSON.parse(cut))).toEqual([
          { type: "Patient", ids: ["p1", "p2"] },
          { type: "Patient", ids: ["p3"] },
          { type: "Observation", ids: ["o1", "o2"] }
        ])
      })
    ))

  it("splits an empty store into one unit that reindexes nothing", () =>
    bench((given) =>
      Effect.gen(function* () {
        const job = yield* pump(given, "reindex", "{}")
        const marks = yield* given.depot.marks(job)
        expect(marks.length).toBe(1)
        expect(marks[0]?.scanned).toBe(0)
      })
    ))
})

describe("targeted reindex", () => {
  it("reads only the one resource a single-resource reindex names", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const job = yield* pump(
          given,
          "reindex",
          JSON.stringify({ type: "Patient", id: "p2" })
        )
        expect(yield* scanned(given.depot, job)).toBe(1)
        const marks = yield* given.depot.marks(job)
        expect(marks.length).toBe(1)
        expect(marks[0]?.written).toBe(3)
      })
    ))

  it("reads only the type a type-scoped reindex names", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const job = yield* pump(
          given,
          "reindex",
          JSON.stringify({ type: "Observation" })
        )
        expect(yield* scanned(given.depot, job)).toBe(2)
      })
    ))

  it("reads everything only when nothing narrows the reindex", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const job = yield* pump(given, "reindex", "{}")
        expect(yield* scanned(given.depot, job)).toBe(5)
      })
    ))

  it("rebuilds an index that was lost", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* given.sql("delete from resource_index")
        expect(yield* given.store.matching("Patient", [["gender", "male"]]))
          .toEqual([])
        yield* pump(given, "reindex", JSON.stringify({ type: "Patient" }))
        const found = yield* given.store.matching("Patient", [
          ["gender", "male"]
        ])
        expect(found.map((one) => one.id)).toEqual(["p1", "p2", "p3"])
      })
    ))

  it("rebuilds one resource without touching the rest of the index", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* given.sql("delete from resource_index")
        yield* pump(
          given,
          "reindex",
          JSON.stringify({ type: "Patient", id: "p1" })
        )
        const found = yield* given.store.matching("Patient", [
          ["gender", "male"]
        ])
        expect(found.map((one) => one.id)).toEqual(["p1"])
      })
    ))

  it("leaves the index no larger for having been rebuilt", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const before = yield* given.sql(
          "select count(*) as n from resource_index"
        )
        yield* pump(given, "reindex", "{}")
        const after = yield* given.sql(
          "select count(*) as n from resource_index"
        )
        expect(Number(after[0]?.["n"])).toBe(Number(before[0]?.["n"]))
      })
    ))

  it("itemizes a resource that went away before the unit ran", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "reindex")
        const payloads = yield* handler.split(
          JSON.stringify({ type: "Patient" })
        )
        const job = yield* given.queue.submit({
          kind: "reindex",
          payloads,
          correlation: "c-1",
          maxAttempts: 3
        })
        yield* given.store.purge("Patient", "p2")
        const unit = yield* given.queue.lease("w-1", ["reindex"], 60_000)
        if (unit === undefined) throw new Error("expected a unit")
        yield* resume({ correlation: unit.correlation }, handler.run(unit))
        const found = yield* given.depot.faults(job)
        expect(found.map((one) => one.id)).toEqual(["p2"])
        expect(found[0]?.reason).toBe("Patient/p2 not found")
      })
    ))
})
