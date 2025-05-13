import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import {
  Rules,
  Versions,
  create,
  defaults,
  remove,
  update
} from "../core/interactions.js"
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

const patient = (id: string, gender: string): FhirResource => ({
  resourceType: "Patient",
  id,
  gender,
  name: [{ family: `Fam-${id}` }]
})

const seed = (store: Versioned, body: FhirResource) =>
  create(body.resourceType, body).pipe(
    Effect.provideService(Versions, store),
    Effect.provideService(Rules, defaults)
  )

const world = (store: Versioned) =>
  Effect.gen(function* () {
    for (const one of ["p1", "p2", "p3", "p4"]) {
      yield* seed(store, patient(one, one === "p4" ? "female" : "male"))
    }
  })

const soften = (store: Versioned, id: string) =>
  remove("Patient", id).pipe(Effect.provideService(Versions, store))

const live = (store: Versioned) =>
  Effect.map(store.matching("Patient", []), (found) =>
    found.map((one) => one.id)
  )

const ask = (given: Record<string, unknown>) =>
  JSON.stringify({ type: "Patient", ...given })

describe("bulk delete splitting", () => {
  it("splits the matching resources into chunks", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "bulk-delete")
        const cuts = yield* handler.split(ask({ chunk: 3 }))
        expect(cuts.length).toBe(2)
        expect(JSON.parse(cuts[0] ?? "{}")).toEqual({
          type: "Patient",
          ids: ["p1", "p2", "p3"],
          mode: "soft"
        })
      })
    ))

  it("keeps to the criteria it was given", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "bulk-delete")
        const cuts = yield* handler.split(
          ask({ criteria: [["gender", "female"]] })
        )
        expect((JSON.parse(cuts[0] ?? "{}") as { ids: [] }).ids).toEqual(["p4"])
      })
    ))

  it("refuses a count that is not a count", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "bulk-delete"), (handler) =>
          handler.split(ask({ _maxCount: 0 }))
        )
      )
    ).resolves.toBe("Rejected"))

  it("refuses criteria on the already soft deleted", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "bulk-delete"), (handler) =>
          handler.split(
            ask({ softDeleted: true, criteria: [["gender", "male"]] })
          )
        )
      )
    ).resolves.toBe("Rejected"))

  it("refuses a type that is not served", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "bulk-delete"), (handler) =>
          handler.split(JSON.stringify({ type: "Practitioner" }))
        )
      )
    ).resolves.toBe("Rejected"))
})

describe("bulk delete", () => {
  it("soft deletes every matching resource of the type", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const job = yield* pump(given, "bulk-delete", ask({ chunk: 2 }))
        expect(yield* live(given.store)).toEqual([])
        const found = yield* given.store.current("Patient", "p1")
        expect(found?.deleted).toBe(true)
        expect((yield* given.store.history("Patient", "p1")).length).toBe(2)
        const marks = yield* given.depot.marks(job)
        expect(marks.reduce((n, one) => n + one.written, 0)).toBe(4)
      })
    ))

  it("keeps the resources an exclusion names", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* pump(given, "bulk-delete", ask({ exclude: ["p2", "p4"] }))
        expect(yield* live(given.store)).toEqual(["p2", "p4"])
      })
    ))

  it("stops at the count it was given", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* pump(given, "bulk-delete", ask({ _maxCount: 2 }))
        expect(yield* live(given.store)).toEqual(["p3", "p4"])
      })
    ))

  it("hard deletes with the whole history of the resource", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* update("Patient", "p1", patient("p1", "other")).pipe(
          Effect.provideService(Versions, given.store),
          Effect.provideService(Rules, defaults)
        )
        expect((yield* given.store.history("Patient", "p1")).length).toBe(2)
        yield* pump(given, "bulk-delete", ask({ mode: "hard" }))
        expect(yield* live(given.store)).toEqual([])
        expect(yield* given.store.history("Patient", "p1")).toEqual([])
        expect(yield* given.store.currents("Patient", "p1")).toBe(0)
      })
    ))

  it("hard deletes what was already soft deleted", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        yield* soften(given.store, "p1")
        yield* soften(given.store, "p2")
        const job = yield* pump(given, "bulk-delete", ask({ softDeleted: true }))
        expect(yield* given.store.history("Patient", "p1")).toEqual([])
        expect(yield* given.store.history("Patient", "p2")).toEqual([])
        expect((yield* given.store.history("Patient", "p3")).length).toBe(1)
        const marks = yield* given.depot.marks(job)
        expect(marks.reduce((n, one) => n + one.written, 0)).toBe(2)
      })
    ))

  it("splits nothing to delete into one unit that deletes nothing", () =>
    bench((given) =>
      Effect.gen(function* () {
        const job = yield* pump(given, "bulk-delete", ask({}))
        const marks = yield* given.depot.marks(job)
        expect(marks.length).toBe(1)
        expect(marks[0]?.written).toBe(0)
      })
    ))

  it("itemizes a resource that went away before the unit ran", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "bulk-delete")
        const payloads = yield* handler.split(ask({}))
        const job = yield* given.queue.submit({
          kind: "bulk-delete",
          payloads,
          correlation: "c-1",
          maxAttempts: 3
        })
        yield* given.store.purge("Patient", "p2")
        const unit = yield* given.queue.lease("w-1", ["bulk-delete"], 60_000)
        if (unit === undefined) throw new Error("expected a unit")
        yield* resume({ correlation: unit.correlation }, handler.run(unit))
        const found = yield* given.depot.faults(job)
        expect(found.map((one) => one.id)).toEqual(["p2"])
        expect(found[0]?.reason).toBe("Patient/p2 not found")
        expect(yield* live(given.store)).toEqual([])
      })
    ))

  it("counts a resource already soft deleted as no change", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* world(given.store)
        const handler = yield* handlerOf(given.held, "bulk-delete")
        const payloads = yield* handler.split(ask({}))
        const job = yield* given.queue.submit({
          kind: "bulk-delete",
          payloads,
          correlation: "c-1",
          maxAttempts: 3
        })
        yield* soften(given.store, "p3")
        const unit = yield* given.queue.lease("w-1", ["bulk-delete"], 60_000)
        if (unit === undefined) throw new Error("expected a unit")
        yield* resume({ correlation: unit.correlation }, handler.run(unit))
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.written).toBe(3)
        expect(marks[0]?.skipped).toBe(1)
      })
    ))
})
