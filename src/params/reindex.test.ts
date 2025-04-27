import { describe, expect, it } from "vitest"
import { Effect, Exit, Fiber, Option } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { engineOn } from "../store/store.js"
import type { Store } from "../store/store.js"
import type { Definition } from "./model.js"
import { registryOn } from "./registry.js"
import type { Registry } from "./registry.js"
import { backfill, emit } from "./reindex.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { readonly _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const BORN: Definition = {
  type: "Patient",
  name: "born",
  valueType: "date",
  path: ["birthDate"],
  targets: [],
  components: []
}

const CALLED: Definition = {
  type: "Patient",
  name: "called",
  valueType: "string",
  path: ["name", "text"],
  targets: [],
  components: []
}

interface Db {
  readonly one: Registry
  readonly two: Registry
  readonly left: DuckDBConnection
  readonly store: Store
}

const open = async (): Promise<Db> => {
  const instance = await DuckDBInstance.create(":memory:")
  const left = await instance.connect()
  const right = await instance.connect()
  const store = await run(engineOn(left))
  const one = await run(registryOn(left))
  const two = await run(registryOn(right))
  return { one, two, left, store }
}

const patient = (db: Db, id: string, birthDate: string) =>
  run(db.store.put({ resourceType: "Patient", id, birthDate }))

describe("index emission", () => {
  it("turns a value into an entry for every indexable type", () => {
    expect(emit({ ...BORN, valueType: "token" }, "male")).toEqual({
      _tag: "Typed",
      entry: { kind: "token", name: "born", system: undefined, code: "male", text: "male" }
    })
    expect(emit({ ...BORN, valueType: "number" }, "4.5")).toEqual({
      _tag: "Typed",
      entry: { kind: "number", name: "born", value: 4.5 }
    })
    expect(emit({ ...BORN, valueType: "quantity" }, "70")).toEqual({
      _tag: "Typed",
      entry: { kind: "quantity", name: "born", value: 70, system: undefined, code: undefined }
    })
    expect(emit(CALLED, "Simpson")).toEqual({ _tag: "Plain", value: "Simpson" })
    expect(emit({ ...CALLED, valueType: "uri" }, "http://x/y")).toEqual({
      _tag: "Plain",
      value: "http://x/y"
    })
  })

  it("splits a reference into its type and its id", () => {
    expect(emit({ ...BORN, valueType: "reference" }, "Patient/p1")).toEqual({
      _tag: "Typed",
      entry: {
        kind: "reference",
        name: "born",
        targetType: "Patient",
        targetId: "p1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    })
  })

  it("keeps an absolute reference as a url", () => {
    const found = emit({ ...BORN, valueType: "reference" }, "http://far/Patient/p1")
    expect(found._tag).toBe("Typed")
    expect(found).toMatchObject({ entry: { url: "http://far/Patient/p1" } })
  })

  it("keeps a bare reference as an untyped id", () => {
    expect(emit({ ...BORN, valueType: "reference" }, "p1")).toMatchObject({
      entry: { targetType: undefined, targetId: "p1" }
    })
  })

  it("refuses a value the parameter type cannot hold", () => {
    expect(emit(BORN, "sometime")).toEqual({
      _tag: "Refused",
      reason: "Patient.born: not a date: sometime"
    })
    expect(emit({ ...BORN, valueType: "number" }, "many")).toEqual({
      _tag: "Refused",
      reason: "Patient.born: not a number: many"
    })
    expect(emit({ ...BORN, valueType: "composite" }, "a$b")).toEqual({
      _tag: "Refused",
      reason: "Patient.born: a composite parameter cannot be indexed"
    })
  })

  it("stamps a date as a closed range", () => {
    expect(emit(BORN, "1970-01-02")).toMatchObject({
      entry: { kind: "date", low: "1970-01-02T00:00:00.000Z" }
    })
  })
})

describe("reindex job", () => {
  it("backfills every resource and puts the parameter in force", async () => {
    const db = await open()
    await patient(db, "p1", "1970-01-01")
    await patient(db, "p2", "1980-05-05")
    await run(db.one.create(BORN))
    const found = await run(backfill(db.left, db.one, { type: "Patient", name: "born", version: 1 }))
    expect(found).toMatchObject({ done: 2, total: 2, status: "active" })
    expect(found.faults).toEqual([])
    expect(await run(db.two.indexed("Patient", "born"))).toBe(2)
    expect((await run(db.two.find("Patient", "born"))).status).toBe("active")
  })

  it("indexes a plain parameter into the shared value table", async () => {
    const db = await open()
    await run(db.store.put({ resourceType: "Patient", id: "p1", name: [{ text: "Bess" }] }))
    await run(db.one.create(CALLED))
    await run(backfill(db.left, db.one, { type: "Patient", name: "called", version: 1 }))
    expect(await run(db.two.indexed("Patient", "called"))).toBe(1)
  })

  it("reports a failure per resource and finishes the run", async () => {
    const db = await open()
    await patient(db, "p1", "1970-01-01")
    await patient(db, "p2", "sometime")
    await patient(db, "p3", "1990-09-09")
    await run(db.one.create(BORN))
    const found = await run(backfill(db.left, db.one, { type: "Patient", name: "born", version: 1 }))
    expect(found.done).toBe(3)
    expect(found.status).toBe("failed")
    expect(found.faults.map((one) => one.id)).toEqual(["p2"])
    expect(await run(db.two.indexed("Patient", "born"))).toBe(2)
    const kept = await run(db.two.faults("Patient", "born"))
    expect(kept[0]?.reason).toContain("not a date")
  })

  it("reports an unreadable body as one resource failure", async () => {
    const db = await open()
    await patient(db, "p1", "1970-01-01")
    await db.left.run(
      `insert into resource
         (surrogate_id, resource_type, logical_id, version_id, last_updated,
          deleted, is_current, body)
       values (nextval('surrogate_id'), 'Patient', 'p9', 1, current_timestamp,
               false, true, 'not json')`
    )
    await run(db.one.create(BORN))
    const found = await run(backfill(db.left, db.one, { type: "Patient", name: "born", version: 1 }))
    expect(found.faults.map((one) => one.id)).toEqual(["p9"])
    expect(found.status).toBe("failed")
  })

  it("puts a parameter in force when nothing is stored yet", async () => {
    const db = await open()
    await run(db.one.create(BORN))
    const found = await run(backfill(db.left, db.one, { type: "Patient", name: "born", version: 1 }))
    expect(found).toMatchObject({ done: 0, total: 0, status: "active" })
  })

  it("reports progress to the shared registry while it runs", async () => {
    const db = await open()
    for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
      await patient(db, id, "1970-01-01")
    }
    await run(db.one.create(BORN))
    const seen = await run(
      Effect.gen(function* () {
        const worker = yield* Effect.fork(
          backfill(db.left, db.one, { type: "Patient", name: "born", version: 1 }, 1)
        )
        const out: Array<number> = []
        for (let round = 0; round < 200; round++) {
          const live = Option.isNone(yield* Fiber.poll(worker))
          if (!live) break
          const held = yield* db.two.find("Patient", "born")
          out.push(held.done)
          yield* Effect.yieldNow()
        }
        yield* Fiber.join(worker)
        return out
      })
    )
    expect(new Set(seen).size).toBeGreaterThan(1)
    expect(seen.some((one) => one > 0 && one < 6)).toBe(true)
  })

  it("refuses a job that names a version the registry has moved past", async () => {
    const db = await open()
    await run(db.one.create(BORN))
    expect(
      tag(await exit(backfill(db.left, db.one, { type: "Patient", name: "born", version: 4 })))
    ).toBe("Conflict")
  })

  it("refuses a job for a parameter that is not registered", async () => {
    const db = await open()
    expect(
      tag(await exit(backfill(db.left, db.one, { type: "Patient", name: "born", version: 1 })))
    ).toBe("NotFound")
  })
})

describe("reindex faults", () => {
  it("reports the store as unavailable when the resources are out of reach", async () => {
    const instance = await DuckDBInstance.create(":memory:")
    const bare = await instance.connect()
    const registry = await run(registryOn(bare))
    await run(registry.create(BORN))
    expect(
      tag(await exit(backfill(bare, registry, { type: "Patient", name: "born", version: 1 })))
    ).toBe("Unavailable")
  })
})
