import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import type { FhirResource } from "./engine.js"
import {
  Rules,
  Versions,
  conditionalCreate,
  conditionalPatch,
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
} from "./interactions.js"
import type { Policy, Version, VersionedStore } from "./interactions.js"

const instant = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const patient = (family: string): FhirResource => ({
  resourceType: "Patient",
  family,
  name: [{ family, given: ["Homer"] }]
})

const fake = () => {
  const rows: Array<Version> = []
  let ids = 0
  let ticks = 0
  const pick = (type: string, id: string) =>
    rows.filter((row) => row.type === type && row.id === id).sort((a, b) => b.versionId - a.versionId)
  const port: VersionedStore = {
    current: (type, id) => Effect.succeed(pick(type, id)[0]),
    versionAt: (type, id, versionId) =>
      Effect.succeed(pick(type, id).find((row) => row.versionId === versionId)),
    history: (type, id) => Effect.succeed(pick(type, id)),
    insertVersion: (entry) =>
      Effect.sync(() => {
        rows.push(entry)
      }),
    markDeleted: (type, id, versionId, lastUpdated) =>
      Effect.sync(() => {
        rows.push({ type, id, versionId, lastUpdated, deleted: true, body: { resourceType: type, id } })
      }),
    purge: (type, id) =>
      Effect.sync(() => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i]
          if (row !== undefined && row.type === type && row.id === id) rows.splice(i, 1)
        }
      }),
    matching: (type, criteria) =>
      Effect.succeed(
        rows.filter(
          (row) =>
            row.type === type &&
            !row.deleted &&
            pick(row.type, row.id)[0]?.versionId === row.versionId &&
            criteria.every(
              ([name, value]) => String((row.body as Record<string, unknown>)[name]) === value
            )
        )
      ),
    mint: () =>
      Effect.sync(() => {
        ids += 1
        return `g${ids}`
      }),
    stamp: () =>
      Effect.sync(() => {
        ticks += 1
        return instant(ticks)
      })
  }
  return { port, rows }
}

const world = (policy: Policy = defaults) => {
  const { port, rows } = fake()
  const live = Layer.merge(Layer.succeed(Versions, port), Layer.succeed(Rules, policy))
  const run = <A, E>(effect: Effect.Effect<A, E, Versions | Rules>) =>
    Effect.runPromise(Effect.provide(effect, live))
  const exit = <A, E>(effect: Effect.Effect<A, E, Versions | Rules>) =>
    Effect.runPromiseExit(Effect.provide(effect, live))
  return { run, exit, rows }
}

const failed = <A, E>(result: Exit.Exit<A, E>): { readonly _tag: string; readonly reason?: string } => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return result.cause.error as { readonly _tag: string; readonly reason?: string }
  }
  throw new Error("expected a failure")
}

describe("REST-01 read and vread", () => {
  it("reports a resource that was never written as not found", async () => {
    const { exit } = world()
    expect(failed(await exit(read("Patient", "p1")))._tag).toBe("NotFound")
  })

  it("reads back the current version", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(update("Patient", "p1", patient("Flanders")))
    expect((await run(read("Patient", "p1")))["family"]).toBe("Flanders")
  })

  it("reports a deleted resource as gone rather than missing", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(remove("Patient", "p1"))
    expect(failed(await exit(read("Patient", "p1")))._tag).toBe("Gone")
  })

  it("reports a version that never existed as not found", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    expect(failed(await exit(vread("Patient", "p1", "7")))._tag).toBe("NotFound")
  })

  it("reports a version of an unwritten resource as not found", async () => {
    const { exit } = world()
    expect(failed(await exit(vread("Patient", "p1", "1")))._tag).toBe("NotFound")
  })

  it("reports a version that is not a number as not found", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    expect(failed(await exit(vread("Patient", "p1", "latest")))._tag).toBe("NotFound")
  })

  it("returns the content of an old version, not the current one", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(update("Patient", "p1", patient("Flanders")))
    const old = await run(vread("Patient", "p1", "1"))
    expect(old["family"]).toBe("Simpson")
    expect((old["meta"] as { versionId: string }).versionId).toBe("1")
  })

  it("reports a deleted version as gone", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(remove("Patient", "p1"))
    expect(failed(await exit(vread("Patient", "p1", "2")))._tag).toBe("Gone")
  })

  it("refuses a name that is not a resource type", async () => {
    const { exit } = world()
    expect(failed(await exit(read("patient", "p1")))._tag).toBe("Rejected")
  })

  it("refuses an id that is not a resource id", async () => {
    const { exit } = world()
    expect(failed(await exit(read("Patient", "p 1")))._tag).toBe("Rejected")
  })
})

describe("REST-02 create", () => {
  it("assigns an id when none is supplied and reports location and version", async () => {
    const { run } = world()
    const written = await run(create("Patient", patient("Simpson")))
    expect(written.created).toBe(true)
    expect(written.versionId).toBe(1)
    expect(written.location).toBe("Patient/g1/_history/1")
    expect(written.etag).toBe(etagOf(1))
    expect(written.resource.id).toBe("g1")
  })

  it("keeps a client-supplied id", async () => {
    const { run } = world()
    const written = await run(create("Patient", patient("Simpson"), "p1"))
    expect(written.resource.id).toBe("p1")
    expect(written.location).toBe("Patient/p1/_history/1")
  })

  it("takes the id from the body when no id is supplied", async () => {
    const { run } = world()
    const written = await run(create("Patient", { ...patient("Simpson"), id: "p9" }))
    expect(written.resource.id).toBe("p9")
  })

  it("refuses a create over an id that already exists", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    expect(failed(await exit(create("Patient", patient("Flanders"), "p1")))._tag).toBe("Conflict")
  })

  it("refuses a create over an id that was deleted", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(remove("Patient", "p1"))
    expect(failed(await exit(create("Patient", patient("Simpson"), "p1")))._tag).toBe("Conflict")
  })

  it("refuses a body whose type differs from the type addressed", async () => {
    const { exit } = world()
    expect(failed(await exit(create("Observation", patient("Simpson"), "o1")))._tag).toBe("Rejected")
  })

  it("refuses a supplied id that contradicts the body", async () => {
    const { exit } = world()
    const body = { ...patient("Simpson"), id: "p2" }
    expect(failed(await exit(create("Patient", body, "p1")))._tag).toBe("Rejected")
  })
})

describe("REST-03 update with if-match", () => {
  it("updates and increments the version on a matching tag", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const written = await run(update("Patient", "p1", patient("Flanders"), etagOf(1)))
    expect(written.versionId).toBe(2)
    expect(written.changed).toBe(true)
    expect(written.created).toBe(false)
  })

  it("accepts a bare version without the weak prefix", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    expect((await run(update("Patient", "p1", patient("Flanders"), "1"))).versionId).toBe(2)
  })

  it("refuses a stale tag and writes no new version", async () => {
    const { run, exit, rows } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(update("Patient", "p1", patient("Flanders")))
    const before = rows.length
    expect(failed(await exit(update("Patient", "p1", patient("Burns"), etagOf(1))))._tag).toBe("Conflict")
    expect(rows.length).toBe(before)
    expect((await run(read("Patient", "p1")))["family"]).toBe("Flanders")
  })

  it("allows a missing tag by default", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    expect((await run(update("Patient", "p1", patient("Flanders")))).versionId).toBe(2)
  })

  it("refuses a missing tag when the policy requires one", async () => {
    const { run, exit } = world({ requireVersion: true, skipNoOp: true })
    await run(create("Patient", patient("Simpson"), "p1"))
    expect(failed(await exit(update("Patient", "p1", patient("Flanders"))))._tag).toBe("Conflict")
  })

  it("refuses a tag on a resource that has no version yet", async () => {
    const { exit } = world()
    expect(failed(await exit(update("Patient", "p1", patient("Simpson"), etagOf(1))))._tag).toBe("Conflict")
  })

  it("creates the resource when an update addresses an absent id", async () => {
    const { run } = world()
    const written = await run(update("Patient", "p1", patient("Simpson")))
    expect(written.created).toBe(true)
    expect(written.versionId).toBe(1)
  })

  it("brings back a deleted resource as a further version", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(remove("Patient", "p1"))
    const written = await run(update("Patient", "p1", patient("Flanders")))
    expect(written.versionId).toBe(3)
    expect(written.created).toBe(true)
  })

  it("refuses a body id that contradicts the id addressed", async () => {
    const { exit } = world()
    const body = { ...patient("Simpson"), id: "p2" }
    expect(failed(await exit(update("Patient", "p1", body)))._tag).toBe("Rejected")
  })
})

describe("REST-04 versioned-update policy", () => {
  it("creates no version when the content is unchanged", async () => {
    const { run, rows } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const before = rows.length
    const written = await run(update("Patient", "p1", patient("Simpson")))
    expect(written.changed).toBe(false)
    expect(written.versionId).toBe(1)
    expect(rows.length).toBe(before)
  })

  it("ignores id and meta when deciding whether the content changed", async () => {
    const { run, rows } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const before = rows.length
    const body = { ...patient("Simpson"), id: "p1", meta: { versionId: "99", lastUpdated: instant(9) } }
    expect((await run(update("Patient", "p1", body))).changed).toBe(false)
    expect(rows.length).toBe(before)
  })

  it("writes a version for an unchanged body when the policy says so", async () => {
    const { run, rows } = world({ requireVersion: false, skipNoOp: false })
    await run(create("Patient", patient("Simpson"), "p1"))
    const before = rows.length
    expect((await run(update("Patient", "p1", patient("Simpson")))).versionId).toBe(2)
    expect(rows.length).toBe(before + 1)
  })
})

describe("REST-05 conditional interactions", () => {
  const criteria = [["family", "Simpson"]] as const

  it("creates when the criteria match nothing", async () => {
    const { run } = world()
    const written = await run(conditionalCreate("Patient", patient("Simpson"), [...criteria]))
    expect(written.created).toBe(true)
  })

  it("creates nothing when the criteria match one", async () => {
    const { run, rows } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const before = rows.length
    const written = await run(conditionalCreate("Patient", patient("Simpson"), [...criteria]))
    expect(written.created).toBe(false)
    expect(written.changed).toBe(false)
    expect(rows.length).toBe(before)
  })

  it("refuses a create when the criteria match many", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(create("Patient", patient("Simpson"), "p2"))
    const result = await exit(conditionalCreate("Patient", patient("Simpson"), [...criteria]))
    expect(failed(result)._tag).toBe("Conflict")
  })

  it("creates on an update when the criteria match nothing", async () => {
    const { run } = world()
    const written = await run(conditionalUpdate("Patient", patient("Simpson"), [...criteria]))
    expect(written.created).toBe(true)
    expect(written.resource.id).toBe("g1")
  })

  it("updates the single match", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const body = { resourceType: "Patient", family: "Simpson", note: "seen" }
    const written = await run(conditionalUpdate("Patient", body, [...criteria]))
    expect(written.versionId).toBe(2)
    expect(written.resource.id).toBe("p1")
  })

  it("refuses an update when the criteria match many", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(create("Patient", patient("Simpson"), "p2"))
    const result = await exit(conditionalUpdate("Patient", patient("Simpson"), [...criteria]))
    expect(failed(result)._tag).toBe("Conflict")
  })

  it("deletes the single match", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    expect((await run(conditionalRemove("Patient", [...criteria]))).changed).toBe(true)
    expect(failed(await exit(read("Patient", "p1")))._tag).toBe("Gone")
  })

  it("reports a delete whose criteria match nothing as not found", async () => {
    const { exit } = world()
    expect(failed(await exit(conditionalRemove("Patient", [...criteria])))._tag).toBe("NotFound")
  })

  it("refuses a delete when the criteria match many", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(create("Patient", patient("Simpson"), "p2"))
    expect(failed(await exit(conditionalRemove("Patient", [...criteria])))._tag).toBe("Conflict")
  })

  it("patches the single match", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "Flanders" }] }
    const written = await run(conditionalPatch("Patient", [...criteria], doc))
    expect(written.resource["family"]).toBe("Flanders")
  })

  it("reports a patch whose criteria match nothing as not found", async () => {
    const { exit } = world()
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "Flanders" }] }
    expect(failed(await exit(conditionalPatch("Patient", [...criteria], doc)))._tag).toBe("NotFound")
  })

  it("refuses a patch when the criteria match many", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(create("Patient", patient("Simpson"), "p2"))
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "Flanders" }] }
    expect(failed(await exit(conditionalPatch("Patient", [...criteria], doc)))._tag).toBe("Conflict")
  })

  it("refuses criteria that select everything", async () => {
    const { exit } = world()
    expect(failed(await exit(conditionalRemove("Patient", [])))._tag).toBe("Rejected")
  })
})

describe("REST-06 delete", () => {
  it("hides a soft-deleted resource from conditional resolution", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(remove("Patient", "p1"))
    const written = await run(conditionalCreate("Patient", patient("Simpson"), [["family", "Simpson"]]))
    expect(written.created).toBe(true)
    expect(written.resource.id).toBe("g1")
  })

  it("makes no further version on a second soft delete", async () => {
    const { run, rows } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(remove("Patient", "p1"))
    const before = rows.length
    expect((await run(remove("Patient", "p1"))).changed).toBe(false)
    expect(rows.length).toBe(before)
  })

  it("removes every version on a hard delete", async () => {
    const { run, exit, rows } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(update("Patient", "p1", patient("Flanders")))
    const erased = await run(remove("Patient", "p1", "hard"))
    expect(erased.mode).toBe("hard")
    expect(rows.length).toBe(0)
    expect(failed(await exit(read("Patient", "p1")))._tag).toBe("NotFound")
  })

  it("refuses a delete of something that was never written", async () => {
    const { exit } = world()
    expect(failed(await exit(remove("Patient", "p1")))._tag).toBe("NotFound")
  })

  it("refuses a hard delete of something that was never written", async () => {
    const { exit } = world()
    expect(failed(await exit(remove("Patient", "p1", "hard")))._tag).toBe("NotFound")
  })
})

describe("REST-07 patch", () => {
  const seed = async (run: <A, E>(e: Effect.Effect<A, E, Versions | Rules>) => Promise<A>) => {
    await run(create("Patient", patient("Simpson"), "p1"))
  }

  it("applies add, replace and remove from a json patch", async () => {
    const { run } = world()
    await seed(run)
    const doc = {
      kind: "json",
      ops: [
        { op: "add", path: "/birthDate", value: "1956-05-12" },
        { op: "replace", path: "/name/0/family", value: "Flanders" },
        { op: "remove", path: "/family" }
      ]
    }
    const written = await run(patch("Patient", "p1", doc))
    expect(written.versionId).toBe(2)
    expect(written.resource["birthDate"]).toBe("1956-05-12")
    expect(written.resource["family"]).toBeUndefined()
    const name = written.resource["name"] as ReadonlyArray<{ family: string }>
    expect(name[0]?.family).toBe("Flanders")
  })

  it("inserts into and removes from an array by index", async () => {
    const { run } = world()
    await seed(run)
    const doc = {
      kind: "json",
      ops: [
        { op: "add", path: "/name/0/given/-", value: "Jay" },
        { op: "add", path: "/name/0/given/0", value: "Max" },
        { op: "remove", path: "/name/0/given/1" }
      ]
    }
    const written = await run(patch("Patient", "p1", doc))
    const name = written.resource["name"] as ReadonlyArray<{ given: ReadonlyArray<string> }>
    expect(name[0]?.given).toEqual(["Max", "Jay"])
  })

  it("leaves the resource untouched when one operation does not apply", async () => {
    const { run, exit, rows } = world()
    await seed(run)
    const before = rows.length
    const doc = {
      kind: "json",
      ops: [
        { op: "replace", path: "/family", value: "Flanders" },
        { op: "remove", path: "/absent" }
      ]
    }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
    expect(rows.length).toBe(before)
    expect((await run(read("Patient", "p1")))["family"]).toBe("Simpson")
  })

  it("refuses a path that leads nowhere", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "replace", path: "/absent/0/deep", value: 1 }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses an index outside the collection", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "replace", path: "/name/4", value: {} }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses a collection position that is not a number", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "replace", path: "/name/x", value: {} }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses a pointer that is not a pointer", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "replace", path: "family", value: "x" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses a patch document it cannot read", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "frobnicate", path: "/family" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("applies add, replace and delete from an element patch", async () => {
    const { run } = world()
    await seed(run)
    const doc = {
      kind: "fhirpath",
      ops: [
        { type: "add", path: "Patient", name: "birthDate", value: "1956-05-12" },
        { type: "replace", path: "Patient.name[0].family", value: "Flanders" },
        { type: "delete", path: "Patient.name[0].given[0]" }
      ]
    }
    const written = await run(patch("Patient", "p1", doc))
    expect(written.resource["birthDate"]).toBe("1956-05-12")
    const name = written.resource["name"] as ReadonlyArray<{ family: string; given: ReadonlyArray<string> }>
    expect(name[0]?.family).toBe("Flanders")
    expect(name[0]?.given).toEqual([])
  })

  it("appends to a collection that is already there", async () => {
    const { run } = world()
    await seed(run)
    const doc = {
      kind: "fhirpath",
      ops: [{ type: "add", path: "Patient.name[0]", name: "given", value: "Jay" }]
    }
    const written = await run(patch("Patient", "p1", doc))
    const name = written.resource["name"] as ReadonlyArray<{ given: ReadonlyArray<string> }>
    expect(name[0]?.given).toEqual(["Homer", "Jay"])
  })

  it("adds into a collection the path already names", async () => {
    const { run } = world()
    await seed(run)
    const doc = {
      kind: "fhirpath",
      ops: [{ type: "add", path: "Patient.name[0].given", name: "1", value: "Jay" }]
    }
    const written = await run(patch("Patient", "p1", doc))
    const name = written.resource["name"] as ReadonlyArray<{ given: ReadonlyArray<string> }>
    expect(name[0]?.given).toEqual(["Homer", "Jay"])
  })

  it("refuses adding where a single value already sits", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "fhirpath", ops: [{ type: "add", path: "Patient", name: "family", value: "x" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses an element path not rooted at the type addressed", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "fhirpath", ops: [{ type: "replace", path: "Observation.value", value: 1 }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses an element path it cannot parse", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "fhirpath", ops: [{ type: "replace", path: "Patient.name(0)", value: 1 }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses a patch that would change the id", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "replace", path: "/id", value: "p2" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("refuses a patch that would change the type", async () => {
    const { run, exit } = world()
    await seed(run)
    const doc = { kind: "json", ops: [{ op: "replace", path: "/resourceType", value: "Observation" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Rejected")
  })

  it("reports a patch of an absent resource as not found", async () => {
    const { exit } = world()
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "x" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("NotFound")
  })

  it("reports a patch of a deleted resource as gone", async () => {
    const { run, exit } = world()
    await seed(run)
    await run(remove("Patient", "p1"))
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "x" }] }
    expect(failed(await exit(patch("Patient", "p1", doc)))._tag).toBe("Gone")
  })

  it("refuses a stale tag on a patch and writes no version", async () => {
    const { run, exit, rows } = world()
    await seed(run)
    await run(update("Patient", "p1", patient("Flanders")))
    const before = rows.length
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "Burns" }] }
    expect(failed(await exit(patch("Patient", "p1", doc, etagOf(1))))._tag).toBe("Conflict")
    expect(rows.length).toBe(before)
  })

  it("creates no version when the patch changes nothing", async () => {
    const { run, rows } = world()
    await seed(run)
    const before = rows.length
    const doc = { kind: "json", ops: [{ op: "replace", path: "/family", value: "Simpson" }] }
    expect((await run(patch("Patient", "p1", doc))).changed).toBe(false)
    expect(rows.length).toBe(before)
  })
})

describe("REST-08 instance history", () => {
  const built = async (run: <A, E>(e: Effect.Effect<A, E, Versions | Rules>) => Promise<A>) => {
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(update("Patient", "p1", patient("Flanders")))
    await run(remove("Patient", "p1"))
  }

  it("orders entries newest first and names the interaction", async () => {
    const { run } = world()
    await built(run)
    const entries = await run(history("Patient", "p1"))
    expect(entries.map((entry) => entry.versionId)).toEqual([3, 2, 1])
    expect(entries.map((entry) => entry.method)).toEqual(["DELETE", "PUT", "POST"])
  })

  it("carries no body on a delete entry", async () => {
    const { run } = world()
    await built(run)
    const entries = await run(history("Patient", "p1"))
    expect(entries[0]?.resource).toBeUndefined()
    expect(entries[1]?.resource?.["family"]).toBe("Flanders")
  })

  it("honours _since", async () => {
    const { run } = world()
    await built(run)
    const entries = await run(history("Patient", "p1", { since: instant(2) }))
    expect(entries.map((entry) => entry.versionId)).toEqual([3, 2])
  })

  it("honours _before", async () => {
    const { run } = world()
    await built(run)
    const entries = await run(history("Patient", "p1", { before: instant(2) }))
    expect(entries.map((entry) => entry.versionId)).toEqual([1])
  })

  it("honours _at", async () => {
    const { run } = world()
    await built(run)
    const entries = await run(history("Patient", "p1", { at: "2024-01-01T00:02" }))
    expect(entries.map((entry) => entry.versionId)).toEqual([2])
  })

  it("honours _count", async () => {
    const { run } = world()
    await built(run)
    const entries = await run(history("Patient", "p1", { count: 2 }))
    expect(entries.map((entry) => entry.versionId)).toEqual([3, 2])
  })

  it("refuses a count that is not a whole number of entries", async () => {
    const { run, exit } = world()
    await built(run)
    expect(failed(await exit(history("Patient", "p1", { count: -1 })))._tag).toBe("Rejected")
  })

  it("reports history of a resource that was never written as not found", async () => {
    const { exit } = world()
    expect(failed(await exit(history("Patient", "p1")))._tag).toBe("NotFound")
  })

  it("leaves no history behind a hard delete", async () => {
    const { run, exit } = world()
    await built(run)
    await run(remove("Patient", "p1", "hard"))
    expect(failed(await exit(history("Patient", "p1")))._tag).toBe("NotFound")
  })
})
