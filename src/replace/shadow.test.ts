import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { Version } from "../core/interactions.js"
import { Unavailable } from "../core/outcome.js"
import type { Reader } from "./incumbent.js"
import { sealed } from "./incumbent.js"
import { fake } from "./fake.js"
import { readerOf, shadow, side } from "./shadow.js"
import type { Request } from "./shadow.js"

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const of = (id: string, versionId: number, family: string, deleted = false): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: moment(versionId),
  deleted,
  body: deleted
    ? { resourceType: "Patient", id }
    : { resourceType: "Patient", id, name: [{ family }] }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const reading = (id: string): Request => ({ kind: "read", type: "Patient", id })

const searching = (family: string): Request => ({
  kind: "search",
  type: "Patient",
  criteria: [["family", family]]
})

const withStore = async (use: (store: Versioned) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    await use(await run(versionedOn(connection)))
  } finally {
    connection.closeSync()
  }
}

describe("shadow runner", () => {
  it("serves the same request shapes from both sides", async () => {
    await withStore(async (store) => {
      await run(store.insertVersion(of("p1", 1, "Simpson")))
      const left = side("incumbent", sealed(fake([of("p1", 1, "Simpson")])))
      const right = side("successor", readerOf(store))
      const found = await run(shadow(left, right, [reading("p1"), searching("Simpson")]))
      expect(found.left).toBe("incumbent")
      expect(found.right).toBe("successor")
      expect(found.pair).toHaveLength(2)
      expect(found.pair[0]?.left).toEqual(found.pair[0]?.right)
      expect(found.pair[1]?.left).toEqual({ of: "set", total: 1, id: ["p1"] })
      expect(found.pair[1]?.right).toEqual({ of: "set", total: 1, id: ["p1"] })
    })
  })

  it("reports a missing resource as a refusal rather than a fault", async () => {
    await withStore(async (store) => {
      const left = side("incumbent", sealed(fake([of("p1", 1, "Simpson")])))
      const right = side("successor", readerOf(store))
      const found = await run(shadow(left, right, [reading("p1")]))
      expect(found.pair[0]?.left).toEqual({
        of: "resource",
        body: { resourceType: "Patient", id: "p1", name: [{ family: "Simpson" }] }
      })
      expect(found.pair[0]?.right).toEqual({
        of: "failure",
        tag: "NotFound",
        detail: "Patient/p1 not found"
      })
    })
  })

  it("reports a deleted resource as gone on either side", async () => {
    await withStore(async (store) => {
      await run(store.insertVersion(of("p1", 1, "Simpson")))
      await run(store.markDeleted("Patient", "p1", 2, moment(2)))
      const left = side("incumbent", sealed(fake([of("p1", 1, "Simpson"), of("p1", 2, "", true)])))
      const right = side("successor", readerOf(store))
      const found = await run(shadow(left, right, [reading("p1")]))
      expect(found.pair[0]?.left).toEqual({
        of: "failure",
        tag: "Gone",
        detail: "Patient/p1 deleted"
      })
      expect(found.pair[0]?.right).toEqual(found.pair[0]?.left)
    })
  })

  it("keeps a write on one side off the other, in both directions", async () => {
    await withStore(async (store) => {
      const source = fake([of("p1", 1, "Simpson")])
      const left = side("incumbent", sealed(source))
      const right = side("successor", readerOf(store))
      const before = await run(shadow(left, right, [reading("p1"), reading("p2")]))
      expect(before.pair[0]?.left).toMatchObject({ of: "resource" })
      expect(before.pair[0]?.right).toMatchObject({ of: "failure", tag: "NotFound" })
      await run(store.insertVersion(of("p2", 1, "Flanders")))
      const after = await run(shadow(left, right, [reading("p2")]))
      expect(after.pair[0]?.right).toMatchObject({ of: "resource" })
      expect(after.pair[0]?.left).toMatchObject({ of: "failure", tag: "NotFound" })
      expect(source.all().map((one) => one.id)).toEqual(["p1"])
      expect(await run(store.current("Patient", "p1"))).toBeUndefined()
    })
  })

  it("keeps a failure on one side off the other", async () => {
    await withStore(async (store) => {
      await run(store.insertVersion(of("p1", 1, "Simpson")))
      const broken: Reader = {
        read: () => Effect.fail(new Unavailable({ dependency: "incumbent" })),
        matching: () => Effect.fail(new Unavailable({ dependency: "incumbent" }))
      }
      const left = side("incumbent", broken)
      const right = side("successor", readerOf(store))
      const found = await run(shadow(left, right, [reading("p1"), searching("Simpson")]))
      expect(found.pair[0]?.left).toMatchObject({ of: "failure", tag: "Unavailable" })
      expect(found.pair[0]?.right).toMatchObject({ of: "resource" })
      expect(found.pair[1]?.left).toMatchObject({ of: "failure", tag: "Unavailable" })
      expect(found.pair[1]?.right).toEqual({ of: "set", total: 1, id: ["p1"] })
    })
  })

  it("runs no requests at all without complaint", async () => {
    await withStore(async (store) => {
      const found = await run(
        shadow(side("incumbent", sealed(fake([]))), side("successor", readerOf(store)), [])
      )
      expect(found.pair).toEqual([])
    })
  })
})
