import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Rules, create, defaults, read } from "../core/interactions.js"
import type { Version } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import { Unit, layer, loose, unitOn } from "./unit.js"
import type { Bound } from "./unit.js"

const instant = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const patient = (family: string): FhirResource => ({
  resourceType: "Patient",
  family,
  name: [{ family, given: ["Homer"] }]
})

const version = (id: string, versionId: number, family: string): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: instant(versionId),
  deleted: false,
  body: { ...patient(family), id }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { readonly _tag: string })._tag
  }
  throw new Error("expected a failure")
}

interface Wired {
  readonly connection: DuckDBConnection
  readonly bound: Bound
  readonly rows: (table: string) => Promise<number>
}

const wired = async (): Promise<Wired> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const bound = await run(unitOn(connection))
  const rows = async (table: string): Promise<number> => {
    const reader = await connection.runAndReadAll(`select count(*) as n from ${table}`)
    return Number(reader.getRowObjects()[0]?.["n"] ?? 0)
  }
  return { connection, bound, rows }
}

describe("bundle unit boundary", () => {
  it("passes work through when nothing bounds it", async () => {
    expect(await run(loose.within(Effect.succeed(7)))).toBe(7)
    const broken = loose.within(Effect.fail(new Rejected({ reason: "no" })))
    expect(tag(await exit(broken))).toBe("Rejected")
    expect(loose.lanes).toBe(Number.POSITIVE_INFINITY)
  })

  it("offers one lane for one connection", async () => {
    const { bound } = await wired()
    expect(bound.boundary.lanes).toBe(1)
  })

  it("keeps every write of a unit that succeeds", async () => {
    const { bound, rows } = await wired()
    await run(
      bound.boundary.within(
        Effect.gen(function* () {
          yield* bound.store.insertVersion(version("p1", 1, "Simpson"))
          yield* bound.store.insertVersion(version("p2", 1, "Flanders"))
        })
      )
    )
    expect(await rows("resource")).toBe(2)
    expect((await run(bound.store.current("Patient", "p1")))?.versionId).toBe(1)
  })

  it("undoes every write of a unit that fails", async () => {
    const { bound, rows } = await wired()
    await run(bound.store.insertVersion(version("p0", 1, "Simpson")))
    const before = await rows("resource")
    const index = await rows("resource_index")
    const work = Effect.gen(function* () {
      yield* bound.store.insertVersion(version("p1", 1, "Simpson"))
      yield* bound.store.insertVersion(version("p2", 1, "Flanders"))
      return yield* Effect.fail(new Rejected({ reason: "stop" }))
    })
    expect(tag(await exit(bound.boundary.within(work)))).toBe("Rejected")
    expect(await rows("resource")).toBe(before)
    expect(await rows("resource_index")).toBe(index)
    expect(await run(bound.store.current("Patient", "p1"))).toBeUndefined()
    expect((await run(bound.store.current("Patient", "p0")))?.versionId).toBe(1)
  })

  it("lets the store keep its own atomicity inside a unit", async () => {
    const { bound, rows } = await wired()
    await run(bound.boundary.within(bound.store.insertVersion(version("p1", 1, "Simpson"))))
    await run(bound.store.insertVersion(version("p1", 2, "Flanders")))
    expect(await rows("resource")).toBe(2)
    expect(await run(bound.store.currents("Patient", "p1"))).toBe(1)
  })

  it("leaves the connection usable after a unit is undone", async () => {
    const { bound, rows } = await wired()
    const work = bound.store
      .insertVersion(version("p1", 1, "Simpson"))
      .pipe(Effect.zipRight(Effect.fail(new Rejected({ reason: "stop" }))))
    expect(tag(await exit(bound.boundary.within(work)))).toBe("Rejected")
    await run(bound.store.insertVersion(version("p2", 1, "Flanders")))
    expect(await rows("resource")).toBe(1)
    expect((await run(bound.store.current("Patient", "p2")))?.versionId).toBe(1)
  })

  it("serves the store and the unit as one layer", async () => {
    const live = Layer.merge(layer(":memory:"), Layer.succeed(Rules, defaults))
    const work = Effect.gen(function* () {
      const unit = yield* Unit
      yield* unit.within(create("Patient", patient("Simpson"), "p1"))
      return yield* read("Patient", "p1")
    })
    const found = await run(Effect.provide(work, live))
    expect(found.id).toBe("p1")
  })

  it("reports a store it can no longer reach as an unavailable dependency", async () => {
    const { connection, bound } = await wired()
    connection.closeSync()
    expect(tag(await exit(bound.boundary.within(Effect.succeed(1))))).toBe("Unavailable")
  })

  it("reports a store it cannot open as an unavailable dependency", async () => {
    const live = Layer.merge(
      layer("/does/not/exist/state.duckdb"),
      Layer.succeed(Rules, defaults)
    )
    expect(tag(await exit(Effect.provide(read("Patient", "p1"), live)))).toBe("Unavailable")
  })
})
