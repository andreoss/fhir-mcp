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
import { desk } from "../jobs/service.js"
import { handlerOf } from "../jobs/types.js"
import type { Registry } from "../jobs/types.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import { depotOn } from "./depot.js"
import type { Depot } from "./depot.js"
import { handlers, report } from "./bulk.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

interface Bench {
  readonly store: Versioned
  readonly depot: Depot
  readonly queue: Durable
  readonly held: Registry
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
          return yield* work({
            store,
            depot,
            queue,
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
  })

const PATCH = {
  kind: "json",
  ops: [{ op: "add", path: "/active", value: true }]
}

const ask = (given: Record<string, unknown>) =>
  JSON.stringify({ patch: PATCH, ...given })

describe("bulk update splitting", () => {
  it("reaches every served type when none is named", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "bulk-update")
        const cuts = yield* handler.split(ask({ chunk: 2 }))
        const seen = cuts.map((cut) => JSON.parse(cut) as { type: string })
        expect(seen.map((one) => one.type)).toEqual([
          "Patient",
          "Patient",
          "Observation",
          "Condition",
          "Encounter"
        ])
      })
    ))

  it("keeps to the type and criteria it was named", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "bulk-update")
        const cuts = yield* handler.split(
          ask({ type: "Patient", criteria: [["_id", "p2"]] })
        )
        expect(cuts.length).toBe(1)
        expect((JSON.parse(cuts[0] ?? "{}") as { ids: [] }).ids).toEqual(["p2"])
      })
    ))

  it("refuses a patch that is not a patch", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "bulk-update"), (handler) =>
          handler.split(JSON.stringify({ patch: { kind: "xml" } }))
        )
      )
    ).resolves.toBe("Rejected"))

  it("refuses a type that is not served", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "bulk-update"), (handler) =>
          handler.split(ask({ type: "Practitioner" }))
        )
      )
    ).resolves.toBe("Rejected"))
})

describe("bulk update", () => {
  it("applies the patch to every resource of a type", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const job = yield* pump(
          given,
          "bulk-update",
          ask({ type: "Patient", chunk: 2 })
        )
        for (const one of ["p1", "p2", "p3"]) {
          const found = yield* given.store.current("Patient", one)
          expect(found?.body["active"]).toBe(true)
          expect(found?.versionId).toBe(2)
        }
        const marks = yield* given.depot.marks(job)
        expect(marks.reduce((n, one) => n + one.written, 0)).toBe(3)
      })
    ))

  it("applies the patch across every type when none is named", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* pump(given, "bulk-update", ask({}))
        const found = yield* given.store.current("Observation", "o1")
        expect(found?.body["active"]).toBe(true)
      })
    ))

  it("reports the progress of the job as it goes", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const counter = desk(given.queue, given.held)
        const handler = yield* handlerOf(given.held, "bulk-update")
        const ticket = yield* counter.submit(
          "bulk-update",
          ask({ type: "Patient", chunk: 1 })
        )
        const first = yield* report(counter, given.depot, ticket.id)
        expect(first.state).toBe("queued")
        expect(first.progress.total).toBe(3)
        expect(first.progress.done).toBe(0)
        const unit = yield* given.queue.lease("w-1", ["bulk-update"], 60_000)
        if (unit === undefined) throw new Error("expected a unit")
        yield* resume({ correlation: unit.correlation }, handler.run(unit))
        yield* given.queue.complete(unit)
        const next = yield* report(counter, given.depot, ticket.id)
        expect(next.state).toBe("running")
        expect(next.progress.done).toBe(1)
        expect(next.progress.pending).toBe(2)
        expect(next.detail).toContain("1/3 units")
        expect(next.detail).toContain("1 written")
      })
    ))

  it("counts a patch that changes nothing as no change", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* pump(given, "bulk-update", ask({ type: "Patient" }))
        const job = yield* pump(given, "bulk-update", ask({ type: "Patient" }))
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.written).toBe(0)
        expect(marks[0]?.skipped).toBe(3)
        expect((yield* given.store.history("Patient", "p1")).length).toBe(2)
      })
    ))

  it("itemizes a resource the patch cannot be applied to", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const job = yield* pump(
          given,
          "bulk-update",
          JSON.stringify({
            type: "Patient",
            patch: {
              kind: "json",
              ops: [{ op: "remove", path: "/absent" }]
            }
          })
        )
        const found = yield* given.depot.faults(job)
        expect(found.length).toBe(3)
        expect(found[0]?.reason).toContain("patch path is not there")
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.failed).toBe(3)
      })
    ))

  it("splits nothing to patch into one unit that patches nothing", () =>
    bench((given) =>
      Effect.gen(function* () {
        const job = yield* pump(given, "bulk-update", ask({ type: "Patient" }))
        const marks = yield* given.depot.marks(job)
        expect(marks.length).toBe(1)
        expect(marks[0]?.written).toBe(0)
      })
    ))
})
