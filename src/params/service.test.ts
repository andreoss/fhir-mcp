import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Ref } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { engineOn } from "../store/store.js"
import type { Store } from "../store/store.js"
import type { Definition } from "./model.js"
import { Reindexer } from "./reindex.js"
import type { Queue, Slice } from "./reindex.js"
import { Params, layer, managerOn } from "./service.js"
import type { Manager } from "./service.js"

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

interface Held {
  readonly queue: Queue
  readonly taken: Ref.Ref<ReadonlyArray<Slice>>
}

const fake = (): Effect.Effect<Held> =>
  Effect.gen(function* () {
    const taken = yield* Ref.make<ReadonlyArray<Slice>>([])
    const queue: Queue = {
      submit: (slice) =>
        Ref.update(taken, (list) => [...list, slice]).pipe(
          Effect.as(`${slice.type}.${slice.name}.${slice.version}`)
        )
    }
    return { queue, taken }
  })

interface Db {
  readonly one: Manager
  readonly two: Manager
  readonly store: Store
  readonly taken: Ref.Ref<ReadonlyArray<Slice>>
}

const open = async (): Promise<Db> => {
  const instance = await DuckDBInstance.create(":memory:")
  const left = await instance.connect()
  const right = await instance.connect()
  const store = await run(engineOn(left))
  const held = await run(fake())
  const one = await run(managerOn(left, held.queue))
  const two = await run(managerOn(right, held.queue))
  return { one, two, store, taken: held.taken }
}

describe("parameter management", () => {
  it("installs the declared parameters and admits them", async () => {
    const db = await open()
    expect((await run(db.one.list)).length).toBeGreaterThan(0)
    await run(db.one.admit("Patient", [["family", "Simpson"]]))
    const report = await run(db.one.status("Patient", "family"))
    expect(report).toMatchObject({ status: "active", ready: true, complete: true })
  })

  it("submits a reindex job when a parameter is registered", async () => {
    const db = await open()
    const report = await run(db.one.create(BORN))
    expect(report).toMatchObject({ status: "draft", ready: false, version: 1 })
    expect(await run(Ref.get(db.taken))).toEqual([
      { type: "Patient", name: "born", version: 1 }
    ])
  })

  it("refuses a search on a parameter whose backfill has not finished", async () => {
    const db = await open()
    await run(db.one.create(BORN))
    const refused = await exit(db.two.admit("Patient", [["born", "1970"]]))
    expect(tag(refused)).toBe("Rejected")
  })

  it("admits the parameter once the backfill has run", async () => {
    const db = await open()
    await run(db.store.put({ resourceType: "Patient", id: "p1", birthDate: "1970-01-01" }))
    await run(db.one.create(BORN))
    await run(db.one.update({ type: "Patient", name: "born", version: 1, done: 1, total: 1, faults: [] }))
    await run(db.one.post({ type: "Patient", name: "born", status: "backfilling", version: 1 }))
    const ready = await run(
      db.one.post({ type: "Patient", name: "born", status: "active", version: 2 })
    )
    expect(ready).toMatchObject({ status: "active", ready: true, done: 1, total: 1 })
    await run(db.two.admit("Patient", [["born", "1970"]]))
  })

  it("reports a status change that the model does not allow", async () => {
    const db = await open()
    await run(db.one.create(BORN))
    expect(
      tag(
        await exit(
          db.one.post({ type: "Patient", name: "born", status: "active", version: 1 })
        )
      )
    ).toBe("Rejected")
  })

  it("reports the status of a parameter it has never seen", async () => {
    const db = await open()
    expect(tag(await exit(db.one.status("Patient", "born")))).toBe("NotFound")
    expect(tag(await exit(db.one.read("Patient", "born")))).toBe("NotFound")
  })

  it("resubmits a reindex job when the definition is revised", async () => {
    const db = await open()
    await run(db.one.create(BORN))
    const revised = await run(db.one.revise({ ...BORN, path: ["deceasedDateTime"] }, 1))
    expect(revised).toMatchObject({ version: 2, status: "draft", rows: 0 })
    expect((await run(Ref.get(db.taken))).length).toBe(2)
  })

  it("retires a parameter so no instance will admit it", async () => {
    const db = await open()
    await run(db.one.create(BORN))
    await run(db.one.retire("Patient", "born", 1))
    expect(tag(await exit(db.two.status("Patient", "born")))).toBe("NotFound")
    const refused = await exit(db.two.admit("Patient", [["born", "1970"]]))
    expect(tag(refused)).toBe("Rejected")
  })

  it("converges a second instance on a change the first made", async () => {
    const db = await open()
    await run(db.two.converge)
    await run(db.one.create(BORN))
    const held = await run(db.two.converge)
    expect(held.entries.has("Patient.born")).toBe(true)
  })

  it("is supplied as a layer over its own connection", async () => {
    const held = await run(fake())
    const queue = Layer.succeed(Reindexer, held.queue)
    const found = await run(
      Effect.gen(function* () {
        const manager = yield* Params
        return yield* manager.status("Patient", "family")
      }).pipe(Effect.provide(layer(":memory:", "1 minute").pipe(Layer.provide(queue))))
    )
    expect(found.status).toBe("active")
  })
})

describe("parameter layer faults", () => {
  it("reports the store as unavailable when it cannot be opened", async () => {
    const held = await run(fake())
    const queue = Layer.succeed(Reindexer, held.queue)
    const found = await exit(
      Effect.gen(function* () {
        return yield* Params
      }).pipe(
        Effect.provide(
          layer("/nonexistent/params/store.duckdb", "1 minute").pipe(Layer.provide(queue))
        )
      )
    )
    expect(tag(found)).toBe("Unavailable")
  })
})
