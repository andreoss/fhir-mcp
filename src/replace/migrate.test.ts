import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { Unavailable } from "../core/outcome.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { Version, VersionedStore } from "../core/interactions.js"
import { sealed } from "./incumbent.js"
import { fake } from "./fake.js"
import { migrate, named } from "./migrate.js"

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const of = (
  type: string,
  id: string,
  versionId: number,
  deleted = false,
  family = "Simpson"
): Version => ({
  type,
  id,
  versionId,
  lastUpdated: moment(versionId),
  deleted,
  body: deleted
    ? { resourceType: type, id }
    : { resourceType: type, id, name: [{ family }] }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const withStore = async (use: (store: Versioned) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    await use(await run(versionedOn(connection)))
  } finally {
    connection.closeSync()
  }
}

const held: ReadonlyArray<Version> = [
  of("Patient", "p1", 1, false, "Simpson"),
  of("Patient", "p1", 2, false, "Terwilliger"),
  of("Patient", "p2", 1),
  of("Patient", "p2", 2, true),
  of("Observation", "o1", 1)
]

describe("migration with verification", () => {
  it("carries every resource, version and delete marker across", async () => {
    await withStore(async (store) => {
      const report = await run(migrate(sealed(fake(held)), store))
      expect(report.read).toEqual({ types: 2, resources: 3, versions: 5, deletes: 1 })
      expect(report.written).toBe(5)
      expect(report.verified).toBe(5)
      expect(report.missed).toEqual([])
      expect(report.complete).toBe(true)
      const history = await run(store.history("Patient", "p1"))
      expect(history.map((one) => one.versionId)).toEqual([2, 1])
      const marker = await run(store.current("Patient", "p2"))
      expect(marker?.deleted).toBe(true)
      const current = await run(store.current("Patient", "p1"))
      expect(current?.body["name"]).toEqual([{ family: "Terwilliger" }])
    })
  })

  it("names a record it cannot accept and refuses to call the run complete", async () => {
    await withStore(async (store) => {
      const bad: ReadonlyArray<Version> = [
        ...held,
        of("Patient", "p3 with a space", 1),
        of("patient", "p4", 1),
        of("Patient", "p5", 0),
        { ...of("Patient", "p6", 1), body: { resourceType: "Observation", id: "p6" } }
      ]
      const report = await run(migrate(sealed(fake(bad)), store))
      expect(report.complete).toBe(false)
      expect(report.written).toBe(5)
      expect(named(report)).toEqual([
        "Patient/p3 with a space/_history/1",
        "Patient/p5/_history/0",
        "Patient/p6/_history/1",
        "patient/p4/_history/1"
      ])
      expect(report.missed.map((one) => one.reason)).toEqual([
        "id is not a resource id: p3 with a space",
        "version is not a version: 0",
        "body carries Observation, not Patient",
        "type is not a resource type: patient"
      ])
    })
  })

  it("names a record the store refused to write", async () => {
    await withStore(async (store) => {
      const twice: ReadonlyArray<Version> = [...held, of("Patient", "p1", 1, false, "Other")]
      const report = await run(migrate(sealed(fake(twice)), store))
      expect(report.complete).toBe(false)
      expect(named(report)).toEqual(["Patient/p1/_history/1"])
      expect(report.missed[0]?.reason).toBe("write refused: Conflict")
    })
  })

  it("catches a write that was dropped rather than reporting success", async () => {
    await withStore(async (store) => {
      const dropping: VersionedStore = {
        ...store,
        insertVersion: (entry) =>
          entry.type === "Observation" ? Effect.void : store.insertVersion(entry)
      }
      const report = await run(migrate(sealed(fake(held)), dropping))
      expect(report.written).toBe(5)
      expect(report.verified).toBe(4)
      expect(report.complete).toBe(false)
      expect(named(report)).toEqual(["Observation/o1/_history/1"])
      expect(report.missed[0]?.reason).toBe("not present after the write")
    })
  })

  it("catches a delete marker that arrived as a live version", async () => {
    await withStore(async (store) => {
      const flattening: VersionedStore = {
        ...store,
        insertVersion: (entry) => store.insertVersion({ ...entry, deleted: false })
      }
      const report = await run(migrate(sealed(fake(held)), flattening))
      expect(report.complete).toBe(false)
      expect(named(report)).toEqual(["Patient/p2/_history/2"])
      expect(report.missed[0]?.reason).toBe("delete marker not carried")
    })
  })

  it("names a record the store could not be read back for", async () => {
    await withStore(async (store) => {
      const blind: VersionedStore = {
        ...store,
        versionAt: (type, id, versionId) =>
          type === "Observation"
            ? Effect.fail(new Unavailable({ dependency: "store" }))
            : store.versionAt(type, id, versionId)
      }
      const report = await run(migrate(sealed(fake(held)), blind))
      expect(report.complete).toBe(false)
      expect(named(report)).toEqual(["Observation/o1/_history/1"])
      expect(report.missed[0]?.reason).toBe("read back refused: Unavailable")
    })
  })

  it("reports an empty incumbent as a complete run", async () => {
    await withStore(async (store) => {
      const report = await run(migrate(sealed(fake([])), store))
      expect(report).toEqual({
        read: { types: 0, resources: 0, versions: 0, deletes: 0 },
        written: 0,
        verified: 0,
        missed: [],
        complete: true
      })
    })
  })
})
