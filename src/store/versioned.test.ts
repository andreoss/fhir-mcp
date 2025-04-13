import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { layer, open, plan } from "./versioned.js"
import type { Versioned } from "./versioned.js"
import {
  Rules,
  Versions,
  conditionalCreate,
  conditionalRemove,
  conditionalUpdate,
  create,
  defaults,
  etagOf,
  history,
  patch,
  read,
  remove,
  update,
  vread
} from "../core/interactions.js"
import type { Version } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"

const instant = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const body = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Homer"] }]
})

const entry = (id: string, versionId: number, family: string): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: instant(versionId),
  deleted: false,
  body: body(id, family)
})

const patient = (family: string): FhirResource => ({
  resourceType: "Patient",
  name: [{ family, given: ["Homer"] }]
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const withDb = <A>(use: (db: Versioned) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(open(":memory:"), (db) => Effect.promise(() => use(db))))
  )

const family = (found: Version | undefined): unknown => {
  const names = found?.body["name"] as ReadonlyArray<{ family: string }> | undefined
  return names?.[0]?.family
}

describe("versioned store", () => {
  it("reports nothing for a resource that was never written", () =>
    withDb(async (db) => {
      expect(await run(db.current("Patient", "p1"))).toBeUndefined()
      expect(await run(db.history("Patient", "p1"))).toEqual([])
    }))

  it("reads back what was inserted", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      const found = await run(db.current("Patient", "p1"))
      expect(found?.versionId).toBe(1)
      expect(found?.deleted).toBe(false)
      expect(found?.lastUpdated).toBe(instant(1))
      expect(family(found)).toBe("Simpson")
    }))

  it("returns the body held at a version, not the current one", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      await run(db.insertVersion(entry("p1", 2, "Flanders")))
      expect(family(await run(db.versionAt("Patient", "p1", 1)))).toBe("Simpson")
      expect(family(await run(db.versionAt("Patient", "p1", 2)))).toBe("Flanders")
      expect(family(await run(db.current("Patient", "p1")))).toBe("Flanders")
    }))

  it("reports a version that was never written", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      expect(await run(db.versionAt("Patient", "p1", 7))).toBeUndefined()
    }))

  it("orders history newest first and keeps delete markers in it", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      await run(db.insertVersion(entry("p1", 2, "Flanders")))
      await run(db.markDeleted("Patient", "p1", 3, instant(3)))
      const all = await run(db.history("Patient", "p1"))
      expect(all.map((row) => row.versionId)).toEqual([3, 2, 1])
      expect(all.map((row) => row.deleted)).toEqual([true, false, false])
    }))

  it("demotes the previous version as it inserts the next one", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      await run(db.insertVersion(entry("p1", 2, "Flanders")))
      await run(db.insertVersion(entry("p1", 3, "Burns")))
      expect(await run(db.currents("Patient", "p1"))).toBe(1)
      expect((await run(db.current("Patient", "p1")))?.versionId).toBe(3)
    }))

  it("leaves exactly one current version when an insert fails", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      expect(tag(await exit(db.insertVersion(entry("p1", 1, "Flanders"))))).toBe("Conflict")
      expect(await run(db.currents("Patient", "p1"))).toBe(1)
      const found = await run(db.current("Patient", "p1"))
      expect(found?.versionId).toBe(1)
      expect(family(found)).toBe("Simpson")
    }))

  it("marks a delete as a further version and erases nothing", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      await run(db.markDeleted("Patient", "p1", 2, instant(2)))
      expect((await run(db.history("Patient", "p1"))).length).toBe(2)
      expect(family(await run(db.versionAt("Patient", "p1", 1)))).toBe("Simpson")
      expect((await run(db.current("Patient", "p1")))?.deleted).toBe(true)
      expect(await run(db.currents("Patient", "p1"))).toBe(1)
    }))

  it("purges every version of one resource and nothing of another", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      await run(db.insertVersion(entry("p1", 2, "Simpson")))
      await run(db.insertVersion(entry("p2", 1, "Simpson")))
      await run(db.purge("Patient", "p1"))
      expect(await run(db.history("Patient", "p1"))).toEqual([])
      expect(await run(db.current("Patient", "p1"))).toBeUndefined()
      expect((await run(db.history("Patient", "p2"))).length).toBe(1)
      const found = await run(db.matching("Patient", [["family", "Simpson"]]))
      expect(found.map((row) => row.id)).toEqual(["p2"])
    }))

  it("holds a type it indexes no criteria for", () =>
    withDb(async (db) => {
      await run(
        db.insertVersion({
          type: "Sasquatch",
          id: "s1",
          versionId: 1,
          lastUpdated: instant(1),
          deleted: false,
          body: { resourceType: "Sasquatch", id: "s1" }
        })
      )
      expect((await run(db.current("Sasquatch", "s1")))?.versionId).toBe(1)
      expect((await run(db.history("Sasquatch", "s1"))).length).toBe(1)
      expect(tag(await exit(db.matching("Sasquatch", [])))).toBe("Rejected")
    }))
})

describe("versioned store criteria", () => {
  const seeded = async (db: Versioned) => {
    await run(db.insertVersion(entry("p1", 1, "Simpson")))
    await run(db.insertVersion(entry("p2", 1, "Simpson")))
    await run(db.insertVersion(entry("p3", 1, "Flanders")))
  }

  it("matches nothing, one, and many", () =>
    withDb(async (db) => {
      await seeded(db)
      expect(await run(db.matching("Patient", [["family", "Burns"]]))).toEqual([])
      const one = await run(db.matching("Patient", [["family", "Flanders"]]))
      expect(one.map((row) => row.id)).toEqual(["p3"])
      const many = await run(db.matching("Patient", [["family", "Simpson"]]))
      expect(many.map((row) => row.id)).toEqual(["p1", "p2"])
    }))

  it("counts the same matches in the query as it returns", () =>
    withDb(async (db) => {
      await seeded(db)
      for (const value of ["Burns", "Flanders", "Simpson"]) {
        const criteria = [["family", value]] as const
        const found = await run(db.matching("Patient", [...criteria]))
        expect(await run(db.tally("Patient", [...criteria]))).toBe(found.length)
      }
    }))

  it("builds one bound clause per criterion and none in memory", () => {
    const built = plan("Patient", [["family", "Simpson"], ["given", "Homer"]])
    expect(built.where.match(/exists \(/g)?.length).toBe(2)
    expect(built.where).toContain("from resource_index i")
    expect(built.where).toContain("r.is_current")
    expect(built.where).toContain("not r.deleted")
    expect(built.where).not.toContain("Simpson")
    expect(built.values).toEqual([
      "Patient",
      "Patient",
      "family",
      "Simpson",
      "Patient",
      "given",
      "Homer"
    ])
  })

  it("treats two criteria as both having to match", () =>
    withDb(async (db) => {
      await seeded(db)
      const found = await run(
        db.matching("Patient", [["family", "Simpson"], ["_id", "p2"]])
      )
      expect(found.map((row) => row.id)).toEqual(["p2"])
    }))

  it("keeps a deleted resource out of every match", () =>
    withDb(async (db) => {
      await seeded(db)
      await run(db.markDeleted("Patient", "p1", 2, instant(2)))
      const found = await run(db.matching("Patient", [["family", "Simpson"]]))
      expect(found.map((row) => row.id)).toEqual(["p2"])
    }))

  it("keeps an older version out of every match", () =>
    withDb(async (db) => {
      await run(db.insertVersion(entry("p1", 1, "Simpson")))
      await run(db.insertVersion(entry("p1", 2, "Flanders")))
      expect(await run(db.matching("Patient", [["family", "Simpson"]]))).toEqual([])
      expect((await run(db.matching("Patient", [["family", "Flanders"]]))).length).toBe(1)
    }))

  it("does not let a value ending a quote change the query", () =>
    withDb(async (db) => {
      await seeded(db)
      expect(await run(db.matching("Patient", [["family", "' or 1=1 --"]]))).toEqual([])
    }))

  it("refuses a criterion it does not index rather than scanning", () =>
    withDb(async (db) => {
      expect(tag(await exit(db.matching("Patient", [["colour", "blue"]])))).toBe("Rejected")
      expect(tag(await exit(db.tally("Patient", [["colour", "blue"]])))).toBe("Rejected")
    }))

  it("refuses criteria against a type it does not serve", () =>
    withDb(async (db) => {
      expect(tag(await exit(db.matching("Sasquatch", [["family", "x"]])))).toBe("Rejected")
    }))
})

describe("versioned store ids and stamps", () => {
  it("mints ids that do not collide", () =>
    withDb(async (db) => {
      const minted = await Promise.all(
        Array.from({ length: 500 }, () => run(db.mint("Patient")))
      )
      expect(new Set(minted).size).toBe(500)
      expect(minted.every((id) => /^[A-Za-z0-9\-.]{1,64}$/.test(id))).toBe(true)
    }))

  it("stamps a moment that never goes backwards", () =>
    withDb(async (db) => {
      const stamps = await Promise.all(
        Array.from({ length: 20 }, () => run(db.stamp()))
      )
      const sorted = [...stamps].sort()
      expect(stamps).toEqual(sorted)
      expect(new Set(stamps).size).toBe(20)
    }))

  it("keeps a stamp exactly as it was written", () =>
    withDb(async (db) => {
      const stamp = await run(db.stamp())
      await run(db.insertVersion({ ...entry("p1", 1, "Simpson"), lastUpdated: stamp }))
      expect((await run(db.current("Patient", "p1")))?.lastUpdated).toBe(stamp)
    }))

  it("reports a store it cannot open as an unavailable dependency", async () => {
    expect(tag(await exit(Effect.scoped(open("/does/not/exist/state.duckdb"))))).toBe(
      "Unavailable"
    )
  })

  it("reports a store it can no longer reach as an unavailable dependency", async () => {
    const db = await run(Effect.scoped(open(":memory:")))
    expect(tag(await exit(db.current("Patient", "p1")))).toBe("Unavailable")
  })
})

interface World {
  readonly run: <A, E>(effect: Effect.Effect<A, E, Versions | Rules>) => Promise<A>
  readonly exit: <A, E>(
    effect: Effect.Effect<A, E, Versions | Rules>
  ) => Promise<Exit.Exit<A, E>>
  readonly db: Versioned
}

const world = <A>(use: (world: World) => Promise<A>): Promise<A> =>
  withDb((db) => {
    const live = Layer.merge(Layer.succeed(Versions, db), Layer.succeed(Rules, defaults))
    return use({
      db,
      run: (effect) => Effect.runPromise(Effect.provide(effect, live)),
      exit: (effect) => Effect.runPromiseExit(Effect.provide(effect, live))
    })
  })

describe("interactions over real persistence", () => {
  it("serves the port as a layer", async () => {
    const live = Layer.merge(layer(":memory:"), Layer.succeed(Rules, defaults))
    const work = Effect.gen(function* () {
      yield* create("Patient", patient("Simpson"), "p1")
      return yield* read("Patient", "p1")
    })
    const found = await Effect.runPromise(Effect.provide(work, live))
    expect(found.id).toBe("p1")
  })

  it("creates, stamps and reads back", () =>
    world(async ({ run: go, db }) => {
      const written = await go(create("Patient", patient("Simpson"), "p1"))
      expect(written.created).toBe(true)
      expect(written.versionId).toBe(1)
      expect(written.location).toBe("Patient/p1/_history/1")
      expect(written.etag).toBe(etagOf(1))
      const found = await go(read("Patient", "p1"))
      expect((found["meta"] as { versionId: string }).versionId).toBe("1")
      expect(await run(db.currents("Patient", "p1"))).toBe(1)
    }))

  it("mints an id when none is supplied", () =>
    world(async ({ run: go }) => {
      const written = await go(create("Patient", patient("Simpson")))
      const id = written.resource.id
      expect(typeof id).toBe("string")
      expect(written.location).toBe(`Patient/${String(id)}/_history/1`)
      expect((await go(read("Patient", String(id))))["resourceType"]).toBe("Patient")
    }))

  it("refuses a create over an id that already exists", () =>
    world(async ({ run: go, exit: no }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      expect(tag(await no(create("Patient", patient("Burns"), "p1")))).toBe("Conflict")
    }))

  it("updates on a matching tag and keeps the old version readable", () =>
    world(async ({ run: go }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const written = await go(update("Patient", "p1", patient("Flanders"), etagOf(1)))
      expect(written.versionId).toBe(2)
      expect(written.changed).toBe(true)
      const old = await go(vread("Patient", "p1", "1"))
      const names = old["name"] as ReadonlyArray<{ family: string }>
      expect(names[0]?.family).toBe("Simpson")
    }))

  it("refuses a stale tag and writes no new version", () =>
    world(async ({ run: go, exit: no, db }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      await go(update("Patient", "p1", patient("Flanders")))
      const before = (await run(db.history("Patient", "p1"))).length
      expect(tag(await no(update("Patient", "p1", patient("Burns"), etagOf(1))))).toBe(
        "Conflict"
      )
      expect((await run(db.history("Patient", "p1"))).length).toBe(before)
      const names = (await go(read("Patient", "p1")))["name"] as ReadonlyArray<{
        family: string
      }>
      expect(names[0]?.family).toBe("Flanders")
    }))

  it("writes no version when an update changes nothing", () =>
    world(async ({ run: go, db }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const written = await go(update("Patient", "p1", patient("Simpson")))
      expect(written.changed).toBe(false)
      expect(written.versionId).toBe(1)
      expect((await run(db.history("Patient", "p1"))).length).toBe(1)
    }))

  it("resolves a conditional update onto the single match", () =>
    world(async ({ run: go }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const body = { ...patient("Simpson"), birthDate: "1956-05-12" }
      const written = await go(conditionalUpdate("Patient", body, [["family", "Simpson"]]))
      expect(written.resource.id).toBe("p1")
      expect(written.versionId).toBe(2)
      expect((await go(read("Patient", "p1")))["birthDate"]).toBe("1956-05-12")
    }))

  it("creates when a conditional update matches nothing", () =>
    world(async ({ run: go }) => {
      const written = await go(
        conditionalUpdate("Patient", patient("Simpson"), [["family", "Simpson"]])
      )
      expect(written.created).toBe(true)
      expect(written.versionId).toBe(1)
    }))

  it("refuses a conditional update that matches many", () =>
    world(async ({ run: go, exit: no }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      await go(create("Patient", patient("Simpson"), "p2"))
      const result = await no(
        conditionalUpdate("Patient", patient("Simpson"), [["family", "Simpson"]])
      )
      expect(tag(result)).toBe("Conflict")
    }))

  it("creates nothing when a conditional create matches one", () =>
    world(async ({ run: go, db }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const written = await go(
        conditionalCreate("Patient", patient("Simpson"), [["family", "Simpson"]])
      )
      expect(written.created).toBe(false)
      expect(written.changed).toBe(false)
      expect((await run(db.history("Patient", "p1"))).length).toBe(1)
    }))

  it("soft deletes as a further version and answers gone", () =>
    world(async ({ run: go, exit: no, db }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const erased = await go(remove("Patient", "p1"))
      expect(erased.changed).toBe(true)
      expect(erased.versionId).toBe(2)
      expect(tag(await no(read("Patient", "p1")))).toBe("Gone")
      expect((await run(db.history("Patient", "p1"))).length).toBe(2)
      expect((await go(remove("Patient", "p1"))).changed).toBe(false)
      expect((await run(db.history("Patient", "p1"))).length).toBe(2)
    }))

  it("hides a soft-deleted resource from conditional resolution", () =>
    world(async ({ run: go }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      await go(remove("Patient", "p1"))
      const written = await go(
        conditionalCreate("Patient", patient("Simpson"), [["family", "Simpson"]])
      )
      expect(written.created).toBe(true)
      expect(written.resource.id).not.toBe("p1")
    }))

  it("hard deletes every version and leaves the neighbour alone", () =>
    world(async ({ run: go, exit: no, db }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      await go(update("Patient", "p1", patient("Flanders")))
      await go(create("Patient", patient("Burns"), "p2"))
      const erased = await go(remove("Patient", "p1", "hard"))
      expect(erased.mode).toBe("hard")
      expect(tag(await no(read("Patient", "p1")))).toBe("NotFound")
      expect(tag(await no(history("Patient", "p1")))).toBe("NotFound")
      expect(await run(db.history("Patient", "p2"))).toHaveLength(1)
    }))

  it("removes the single conditional match", () =>
    world(async ({ run: go, exit: no }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      expect((await go(conditionalRemove("Patient", [["family", "Simpson"]]))).changed).toBe(
        true
      )
      expect(tag(await no(read("Patient", "p1")))).toBe("Gone")
    }))

  it("patches a stored resource into a new version", () =>
    world(async ({ run: go }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const doc = {
        kind: "json",
        ops: [
          { op: "add", path: "/birthDate", value: "1956-05-12" },
          { op: "replace", path: "/name/0/family", value: "Flanders" }
        ]
      }
      const written = await go(patch("Patient", "p1", doc))
      expect(written.versionId).toBe(2)
      const found = await go(read("Patient", "p1"))
      expect(found["birthDate"]).toBe("1956-05-12")
      const names = found["name"] as ReadonlyArray<{ family: string }>
      expect(names[0]?.family).toBe("Flanders")
    }))

  it("leaves the stored resource alone when a patch does not apply", () =>
    world(async ({ run: go, exit: no, db }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      const doc = { kind: "json", ops: [{ op: "remove", path: "/absent" }] }
      expect(tag(await no(patch("Patient", "p1", doc)))).toBe("Rejected")
      expect((await run(db.history("Patient", "p1"))).length).toBe(1)
    }))

  it("reports history newest first with the interaction that made it", () =>
    world(async ({ run: go }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      await go(update("Patient", "p1", patient("Flanders")))
      await go(remove("Patient", "p1"))
      const entries = await go(history("Patient", "p1"))
      expect(entries.map((row) => row.versionId)).toEqual([3, 2, 1])
      expect(entries.map((row) => row.method)).toEqual(["DELETE", "PUT", "POST"])
      expect(entries[0]?.resource).toBeUndefined()
      const names = entries[1]?.resource?.["name"] as ReadonlyArray<{ family: string }>
      expect(names[0]?.family).toBe("Flanders")
    }))

  it("narrows history by moment and by count", () =>
    world(async ({ run: go }) => {
      await go(create("Patient", patient("Simpson"), "p1"))
      await go(update("Patient", "p1", patient("Flanders")))
      await go(remove("Patient", "p1"))
      const all = await go(history("Patient", "p1"))
      const second = all[1]?.lastUpdated ?? ""
      expect(
        (await go(history("Patient", "p1", { since: second }))).map((row) => row.versionId)
      ).toEqual([3, 2])
      expect(
        (await go(history("Patient", "p1", { before: second }))).map((row) => row.versionId)
      ).toEqual([1])
      expect((await go(history("Patient", "p1", { count: 2 }))).length).toBe(2)
    }))
})
