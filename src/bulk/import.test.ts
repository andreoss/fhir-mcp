import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
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
import type { Depot, Fault } from "./depot.js"
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

const patient = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family }]
})

const rows = (given: ReadonlyArray<unknown>) =>
  given.map((one) => (typeof one === "string" ? one : JSON.stringify(one)))

const laid = (depot: Depot, path: string, lines: ReadonlyArray<string>) =>
  depot.put(path, lines)

const ask = (path: string, chunk?: number) =>
  JSON.stringify({
    input: [{ type: "Patient", path }],
    ...(chunk === undefined ? {} : { chunk })
  })

const reasons = (found: ReadonlyArray<Fault>) =>
  found.map((one) => `${one.line}: ${one.reason}`)

describe("import splitting", () => {
  it("splits a file into a unit per chunk of lines", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([patient("p1", "A"), patient("p2", "B"), patient("p3", "C")])
        )
        const handler = yield* handlerOf(given.held, "import")
        const cuts = yield* handler.split(ask("in/p.ndjson", 2))
        expect(cuts.map((cut) => JSON.parse(cut))).toEqual([
          { type: "Patient", path: "in/p.ndjson", from: 1, to: 3 },
          { type: "Patient", path: "in/p.ndjson", from: 3, to: 4 }
        ])
      })
    ))

  it("splits an empty file into one unit that reads nothing", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(given.depot, "in/none.ndjson", [])
        const handler = yield* handlerOf(given.held, "import")
        const cuts = yield* handler.split(ask("in/none.ndjson"))
        expect(cuts.length).toBe(1)
      })
    ))

  it("refuses an import that names no input", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "import"), (handler) =>
          handler.split(JSON.stringify({ input: [] }))
        )
      )
    ).resolves.toBe("Rejected"))

  it("refuses an import of a type that is not served", () =>
    expect(
      broke((given) =>
        Effect.flatMap(handlerOf(given.held, "import"), (handler) =>
          handler.split(
            JSON.stringify({ input: [{ type: "Practitioner", path: "x" }] })
          )
        )
      )
    ).resolves.toBe("Rejected"))
})

describe("importing rows", () => {
  it("writes every valid row into the store", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([patient("p1", "A"), patient("p2", "B")])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        const one = yield* given.store.current("Patient", "p1")
        expect(one?.body["name"]).toEqual([{ family: "A" }])
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.written).toBe(2)
        expect(marks[0]?.skipped).toBe(0)
      })
    ))

  it("reports an invalid row by its line and imports the rest", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([
            patient("p1", "A"),
            { resourceType: "Patient", id: "p2", bogus: true },
            patient("p3", "C")
          ])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        const found = yield* given.depot.faults(job)
        expect(found.length).toBe(1)
        expect(found[0]?.line).toBe(2)
        expect(found[0]?.reason).toContain("bogus")
        expect((yield* given.store.current("Patient", "p3"))?.id).toBe("p3")
        expect(yield* given.store.current("Patient", "p2")).toBeUndefined()
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.written).toBe(2)
        expect(marks[0]?.failed).toBe(1)
      })
    ))

  it("reports a row that is not json by its line", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([patient("p1", "A"), "{not json", patient("p3", "C")])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        expect(reasons(yield* given.depot.faults(job))).toEqual([
          "2: row is not json"
        ])
      })
    ))

  it("reports a row that carries no id by its line", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([{ resourceType: "Patient", name: [{ family: "A" }] }])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        expect(reasons(yield* given.depot.faults(job))).toEqual([
          "1: row carries no id"
        ])
      })
    ))

  it("reports a row of another type by its line", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([{ resourceType: "Observation", id: "o1", status: "final" }])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        const found = yield* given.depot.faults(job)
        expect(found[0]?.line).toBe(1)
        expect(found[0]?.reason).toContain("expected Patient")
      })
    ))

  it("counts a line by its place in the file, not in the chunk", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([
            patient("p1", "A"),
            patient("p2", "B"),
            "{not json",
            patient("p4", "D")
          ])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson", 2))
        expect(reasons(yield* given.depot.faults(job))).toEqual([
          "3: row is not json"
        ])
      })
    ))

  it("passes over a blank line without reporting it", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(
          given.depot,
          "in/p.ndjson",
          rows([patient("p1", "A"), "   ", patient("p3", "C")])
        )
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        expect(yield* given.depot.faults(job)).toEqual([])
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.written).toBe(2)
      })
    ))
})

describe("incremental import", () => {
  it("creates no new version for a row already stored", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(given.depot, "in/p.ndjson", rows([patient("p1", "A")]))
        yield* pump(given, "import", ask("in/p.ndjson"))
        const first = yield* given.store.history("Patient", "p1")
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        const second = yield* given.store.history("Patient", "p1")
        expect(first.length).toBe(1)
        expect(second.length).toBe(1)
        expect(second[0]?.versionId).toBe(1)
        const marks = yield* given.depot.marks(job)
        expect(marks[0]?.skipped).toBe(1)
        expect(marks[0]?.written).toBe(0)
      })
    ))

  it("creates a version for a row that changed", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(given.depot, "in/p.ndjson", rows([patient("p1", "A")]))
        yield* pump(given, "import", ask("in/p.ndjson"))
        yield* laid(given.depot, "in/p.ndjson", rows([patient("p1", "B")]))
        const job = yield* pump(given, "import", ask("in/p.ndjson"))
        const found = yield* given.store.history("Patient", "p1")
        expect(found.length).toBe(2)
        expect((yield* given.depot.marks(job))[0]?.written).toBe(1)
      })
    ))

  it("re-running the same unit leaves the version count alone", () =>
    bench((given) =>
      Effect.gen(function* () {
        yield* laid(given.depot, "in/p.ndjson", rows([patient("p1", "A")]))
        const handler = yield* handlerOf(given.held, "import")
        const payloads = yield* handler.split(ask("in/p.ndjson"))
        const job = yield* given.queue.submit({
          kind: "import",
          payloads,
          correlation: "c-1",
          maxAttempts: 3
        })
        const unit = yield* given.queue.lease("w-1", ["import"], 60_000)
        if (unit === undefined) throw new Error("expected a unit")
        yield* resume({ correlation: unit.correlation }, handler.run(unit))
        yield* resume({ correlation: unit.correlation }, handler.run(unit))
        expect((yield* given.store.history("Patient", "p1")).length).toBe(1)
        expect((yield* given.depot.marks(job)).length).toBe(1)
      })
    ))
})
