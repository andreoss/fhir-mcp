import { describe, expect, it, vi } from "vitest"
import { Effect, Exit } from "effect"
import type { Scope } from "effect"
import { open as relational } from "../store/versioned.js"
import { open as documents } from "./document.js"
import type { Version, VersionedStore } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import type { Failure } from "../core/outcome.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

type Backend = (
  path: string
) => Effect.Effect<VersionedStore, Failure, Scope.Scope>

const backends: ReadonlyArray<readonly [string, Backend]> = [
  ["relational", relational],
  ["document", documents]
]

const at = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const body = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Homer"] }],
  gender: "male"
})

const entry = (id: string, versionId: number, family: string): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: at(versionId),
  deleted: false,
  body: body(id, family)
})

const familyOf = (found: Version | undefined): unknown => {
  const names = found?.body["name"] as ReadonlyArray<{ family: string }>
  return names?.[0]?.family
}

const failed = <A>(result: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return result.cause.error
  }
  throw new Error("expected a failure")
}

describe.each(backends)("%s backend", (_name, open) => {
  const held = <A>(
    use: (db: VersionedStore) => Effect.Effect<A, Failure>
  ): Promise<A> =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(open(":memory:"), use)))

  it("reports nothing for a resource that was never written", () =>
    held((db) =>
      Effect.gen(function* () {
        expect(yield* db.current("Patient", "p1")).toBeUndefined()
        expect(yield* db.history("Patient", "p1")).toEqual([])
        expect(yield* db.versionAt("Patient", "p1", 1)).toBeUndefined()
      })
    ))

  it("reads back what was written", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        const found = yield* db.current("Patient", "p1")
        expect(found?.versionId).toBe(1)
        expect(found?.deleted).toBe(false)
        expect(found?.lastUpdated).toBe(at(1))
        expect(found?.type).toBe("Patient")
        expect(found?.id).toBe("p1")
        expect(familyOf(found)).toBe("Simpson")
        expect(found?.body).toEqual(body("p1", "Simpson"))
      })
    ))

  it("moves the current pointer to the newest version", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        expect(familyOf(yield* db.current("Patient", "p1"))).toBe("Flanders")
        expect(
          familyOf(yield* db.versionAt("Patient", "p1", 1))
        ).toBe("Simpson")
      })
    ))

  it("refuses a version that was already written", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        const outcome = yield* Effect.exit(
          db.insertVersion(entry("p1", 1, "Flanders"))
        )
        expect(failed(outcome)._tag).toBe("Conflict")
        expect(familyOf(yield* db.current("Patient", "p1"))).toBe("Simpson")
      })
    ))

  it("lists the history newest first", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        yield* db.insertVersion(entry("p1", 3, "Burns"))
        const seen = yield* db.history("Patient", "p1")
        expect(seen.map((one) => one.versionId)).toEqual([3, 2, 1])
        expect(seen.map((one) => one.lastUpdated)).toEqual([
          at(3),
          at(2),
          at(1)
        ])
      })
    ))

  it("keeps a delete marker in the history and out of matching", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.markDeleted("Patient", "p1", 2, at(2))
        const found = yield* db.current("Patient", "p1")
        expect(found?.deleted).toBe(true)
        expect(found?.versionId).toBe(2)
        expect((yield* db.history("Patient", "p1")).length).toBe(2)
        expect(yield* db.matching("Patient", [])).toEqual([])
      })
    ))

  it("purges every version of a resource", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        yield* db.insertVersion(entry("p2", 1, "Burns"))
        yield* db.purge("Patient", "p1")
        expect(yield* db.current("Patient", "p1")).toBeUndefined()
        expect(yield* db.history("Patient", "p1")).toEqual([])
        expect((yield* db.matching("Patient", [])).length).toBe(1)
      })
    ))

  it("matches on a declared criterion", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p2", 1, "Burns"))
        const found = yield* db.matching("Patient", [["family", "Simpson"]])
        expect(found.map((one) => one.id)).toEqual(["p1"])
        expect(
          (yield* db.matching("Patient", [["_id", "p2"]])).map((one) => one.id)
        ).toEqual(["p2"])
        expect(
          yield* db.matching("Patient", [["family", "Nobody"]])
        ).toEqual([])
      })
    ))

  it("matches on every criterion at once", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p2", 1, "Simpson"))
        const found = yield* db.matching("Patient", [
          ["family", "Simpson"],
          ["_id", "p2"]
        ])
        expect(found.map((one) => one.id)).toEqual(["p2"])
        expect(
          yield* db.matching("Patient", [
            ["family", "Burns"],
            ["_id", "p2"]
          ])
        ).toEqual([])
      })
    ))

  it("matches the newest version only", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        expect(
          yield* db.matching("Patient", [["family", "Simpson"]])
        ).toEqual([])
        expect(
          (yield* db.matching("Patient", [["family", "Flanders"]])).length
        ).toBe(1)
      })
    ))

  it("returns matches in write order", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p2", 1, "Burns"))
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        expect(
          (yield* db.matching("Patient", [])).map((one) => one.id)
        ).toEqual(["p2", "p1"])
        yield* db.insertVersion(entry("p2", 2, "Burns"))
        expect(
          (yield* db.matching("Patient", [])).map((one) => one.id)
        ).toEqual(["p1", "p2"])
      })
    ))

  it("rejects a resource type it does not carry", () =>
    held((db) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(db.matching("Cabbage", []))
        const failure = failed(outcome)
        expect(failure._tag).toBe("Rejected")
        expect(String((failure as { reason: string }).reason)).toContain(
          "unsupported resource type: Cabbage"
        )
      })
    ))

  it("rejects a criterion it does not index", () =>
    held((db) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(
          db.matching("Patient", [["nickname", "Homer"]])
        )
        const failure = failed(outcome)
        expect(failure._tag).toBe("Rejected")
        expect(String((failure as { reason: string }).reason)).toContain(
          "unsupported criterion: nickname"
        )
      })
    ))

  it("mints distinct ids and stamps moments that never go back", () =>
    held((db) =>
      Effect.gen(function* () {
        const ids = yield* Effect.forEach([1, 2, 3], () => db.mint("Patient"))
        expect(new Set(ids).size).toBe(3)
        const stamps = yield* Effect.forEach([1, 2, 3], () => db.stamp())
        expect([...stamps].sort()).toEqual([...stamps])
        expect(new Set(stamps).size).toBe(3)
      })
    ))
})
