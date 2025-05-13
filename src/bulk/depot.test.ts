import { describe, expect, it, vi } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Rules, Versions, create, remove } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { defaults } from "../core/interactions.js"
import type { Failure } from "../core/outcome.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import { depotOn, narrow } from "./depot.js"
import type { Depot } from "./depot.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const wired = <A>(
  work: (
    depot: Depot,
    store: Versioned,
    sql: (text: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>
  ) => Effect.Effect<A, Failure>
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
          const sql = (text: string) =>
            Effect.promise(async () => {
              const reader = await connection.runAndReadAll(text)
              return reader.getRowObjects() as ReadonlyArray<
                Record<string, unknown>
              >
            })
          return yield* work(depot, store, sql)
        })
      )
    )
  )

const broke = <A>(
  work: (
    depot: Depot,
    sql: (text: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>
  ) => Effect.Effect<A, Failure>
): Promise<string> =>
  Effect.runPromiseExit(
    Effect.promise(async () => {
      const instance = await DuckDBInstance.create(":memory:")
      return await instance.connect()
    }).pipe(
      Effect.flatMap((connection: DuckDBConnection) =>
        Effect.gen(function* () {
          const depot = yield* depotOn(connection)
          const sql = (text: string) =>
            Effect.promise(async () => {
              const reader = await connection.runAndReadAll(text)
              return reader.getRowObjects() as ReadonlyArray<
                Record<string, unknown>
              >
            })
          return yield* work(depot, sql)
        })
      )
    )
  ).then((result: Exit.Exit<A, Failure>) => {
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      return result.cause.error._tag
    }
    throw new Error("expected a failure")
  })

const patient = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family }]
})

const seeded = (store: Versioned, body: FhirResource) =>
  create(body.resourceType, body).pipe(
    Effect.provideService(Versions, store),
    Effect.provideService(Rules, defaults)
  )

const dropped = (store: Versioned, type: string, id: string) =>
  remove(type, id).pipe(Effect.provideService(Versions, store))

const note = {
  kind: "export",
  container: "export",
  location: "conf/anon.json",
  etag: 'W/"abc"',
  detail: "started"
}

const tally = {
  type: "Patient",
  path: "export/j1/Patient-0.ndjson",
  written: 2,
  skipped: 0,
  failed: 0,
  scanned: 2
}

describe("the file sink", () => {
  it("keeps the lines a unit writes and gives them back", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.put("a/b.ndjson", ["one", "two"])
        expect(yield* depot.get("a/b.ndjson")).toEqual(["one", "two"])
      })
    ))

  it("gives back no line for a path never written", () =>
    wired((depot) =>
      Effect.gen(function* () {
        expect(yield* depot.get("nowhere")).toEqual([])
      })
    ))

  it("replaces a file rather than appending to it", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.put("a/b.ndjson", ["one", "two"])
        yield* depot.put("a/b.ndjson", ["one", "two"])
        expect(yield* depot.get("a/b.ndjson")).toEqual(["one", "two"])
        const sheets = yield* depot.list("a/")
        expect(sheets).toEqual([{ path: "a/b.ndjson", rows: 2 }])
      })
    ))

  it("lists only the files under a prefix, in order", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.put("j/b.ndjson", ["x"])
        yield* depot.put("j/a.ndjson", ["x", "y"])
        yield* depot.put("k/c.ndjson", ["x"])
        expect((yield* depot.list("j/")).map((one) => one.path)).toEqual([
          "j/a.ndjson",
          "j/b.ndjson"
        ])
      })
    ))
})

describe("the job record", () => {
  it("records what a job was configured with and reads it back", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.note({ job: "j1", ...note })
        const held = yield* depot.noted("j1")
        expect(held?.location).toBe("conf/anon.json")
        expect(held?.etag).toBe('W/"abc"')
        expect(held?.kind).toBe("export")
      })
    ))

  it("keeps one record for a job however often its units run", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.note({ job: "j1", ...note })
        yield* depot.note({ job: "j1", ...note, detail: "again" })
        expect((yield* depot.noted("j1"))?.detail).toBe("again")
      })
    ))

  it("has no record for a job that never ran", () =>
    wired((depot) =>
      Effect.gen(function* () {
        expect(yield* depot.noted("absent")).toBeUndefined()
      })
    ))

  it("keeps one tally per unit whatever the attempt", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.mark({ job: "j1", unit: "u1", ...tally })
        yield* depot.mark({ job: "j1", unit: "u1", ...tally, written: 3 })
        yield* depot.mark({ job: "j1", unit: "u2", ...tally })
        const marks = yield* depot.marks("j1")
        expect(marks.length).toBe(2)
        expect(marks.map((one) => one.written).sort()).toEqual([2, 3])
      })
    ))

  it("replaces the faults a unit itemized on its last attempt", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.fault("j1", "u1", [
          { type: "Patient", id: "p1", line: undefined, reason: "not found" }
        ])
        yield* depot.fault("j1", "u1", [
          { type: "Patient", id: "p1", line: undefined, reason: "not found" }
        ])
        const found = yield* depot.faults("j1")
        expect(found).toEqual([
          {
            job: "j1",
            unit: "u1",
            type: "Patient",
            id: "p1",
            line: undefined,
            reason: "not found"
          }
        ])
      })
    ))

  it("itemizes a fault by line where a row has no identity", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.fault("j1", "u1", [
          { type: "Patient", id: undefined, line: 4, reason: "row is not json" }
        ])
        const found = yield* depot.faults("j1")
        expect(found[0]?.line).toBe(4)
        expect(found[0]?.id).toBeUndefined()
      })
    ))

  it("clears the faults of a unit that then found none", () =>
    wired((depot) =>
      Effect.gen(function* () {
        yield* depot.fault("j1", "u1", [
          { type: "Patient", id: "p1", line: undefined, reason: "not found" }
        ])
        yield* depot.fault("j1", "u1", [])
        expect(yield* depot.faults("j1")).toEqual([])
      })
    ))
})

describe("scanning the store", () => {
  it("names the ids of a type, live or soft deleted", () =>
    wired((depot, store) =>
      Effect.gen(function* () {
        yield* seeded(store, patient("p1", "Vance"))
        yield* seeded(store, patient("p2", "Roe"))
        yield* dropped(store, "Patient", "p2")
        expect(yield* depot.ids("Patient", false)).toEqual(["p1"])
        expect(yield* depot.ids("Patient", true)).toEqual(["p2"])
      })
    ))

  it("narrows the scan to one resource when one is asked for", () => {
    expect(narrow("Patient", ["p1"]).where).toContain("resource_type = ?")
    expect(narrow("Patient", ["p1"]).where).toContain("logical_id in (?)")
    expect(narrow("Patient", ["p1"]).values).toEqual(["Patient", "p1"])
  })

  it("narrows the scan to one type when one is asked for", () => {
    expect(narrow("Patient", []).values).toEqual(["Patient"])
    expect(narrow("Patient", []).where).not.toContain("logical_id")
  })

  it("scans everything only when nothing narrows it", () => {
    expect(narrow(undefined, []).values).toEqual([])
    expect(narrow(undefined, []).where).toBe("is_current and not deleted")
  })

  it("reads only the targets the narrowing names", () =>
    wired((depot, store) =>
      Effect.gen(function* () {
        yield* seeded(store, patient("p1", "Vance"))
        yield* seeded(store, patient("p2", "Roe"))
        yield* seeded(store, {
          resourceType: "Observation",
          id: "o1",
          status: "final",
          code: { coding: [{ code: "x" }] }
        })
        expect((yield* depot.targets(undefined, [])).length).toBe(3)
        expect((yield* depot.targets("Patient", [])).length).toBe(2)
        const one = yield* depot.targets("Patient", ["p1"])
        expect(one.length).toBe(1)
        expect(one[0]?.body.id).toBe("p1")
        expect(one[0]?.type).toBe("Patient")
      })
    ))

  it("passes over a resource that was soft deleted", () =>
    wired((depot, store) =>
      Effect.gen(function* () {
        yield* seeded(store, patient("p1", "Vance"))
        yield* dropped(store, "Patient", "p1")
        expect(yield* depot.targets("Patient", [])).toEqual([])
      })
    ))

  it("rebuilds the index rows of a target it is given", () =>
    wired((depot, store, sql) =>
      Effect.gen(function* () {
        yield* seeded(store, patient("p1", "Vance"))
        yield* sql("delete from resource_index")
        expect(yield* store.matching("Patient", [["family", "Vance"]])).toEqual(
          []
        )
        const targets = yield* depot.targets("Patient", ["p1"])
        const first = targets[0]
        if (first === undefined) throw new Error("expected a target")
        expect(yield* depot.refresh(first)).toBe(2)
        const found = yield* store.matching("Patient", [["family", "Vance"]])
        expect(found.map((one) => one.id)).toEqual(["p1"])
      })
    ))

  it("leaves one index row per value however often it rebuilds", () =>
    wired((depot, store, sql) =>
      Effect.gen(function* () {
        yield* seeded(store, patient("p1", "Vance"))
        const targets = yield* depot.targets("Patient", ["p1"])
        const first = targets[0]
        if (first === undefined) throw new Error("expected a target")
        yield* depot.refresh(first)
        yield* depot.refresh(first)
        const counted = yield* sql("select count(*) as n from resource_index")
        expect(Number(counted[0]?.["n"])).toBe(2)
      })
    ))

  it("reports the store unavailable when a read cannot be made", () =>
    expect(
      broke((depot, sql) =>
        Effect.gen(function* () {
          yield* sql("drop table bulk_file")
          return yield* depot.get("a/b.ndjson")
        })
      )
    ).resolves.toBe("Unavailable"))
})
