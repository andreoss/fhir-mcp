import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { Versions } from "../core/interactions.js"
import type { Version } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import type { Failure } from "../core/outcome.js"
import { layer, open } from "./document.js"
import type { Documents } from "./document.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const at = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const wordy = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Homer", "Jay"] }],
  text: {
    status: "generated",
    div: Array.from(
      { length: 30 },
      () => "<p>A long generated narrative about the patient.</p>"
    ).join("")
  }
})

const entry = (id: string, versionId: number, family: string): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: at(versionId),
  deleted: false,
  body: wordy(id, family)
})

const held = <A>(
  use: (db: Documents) => Effect.Effect<A, Failure>
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(open(":memory:"), use)))

describe("document backend", () => {
  it("keeps every version of a resource in one stored document", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        expect((yield* db.history("Patient", "p1")).length).toBe(2)
        expect(yield* db.documents()).toBe(1)
      })
    ))

  it("stores a document in fewer bytes than its raw form", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        const seen = yield* db.history("Patient", "p1")
        const raw = Buffer.byteLength(JSON.stringify(seen))
        const stored = yield* db.bytes("Patient", "p1")
        expect(stored).toBeGreaterThan(0)
        expect(stored).toBeLessThan(raw / 2)
      })
    ))

  it("reports no bytes for a resource it does not hold", () =>
    held((db) =>
      Effect.gen(function* () {
        expect(yield* db.bytes("Patient", "nobody")).toBe(0)
      })
    ))

  it("records one feed entry per create, update and delete", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.insertVersion(entry("p1", 2, "Flanders"))
        yield* db.markDeleted("Patient", "p1", 3, at(3))
        const seen = yield* db.feed.since(0)
        expect(seen.map((one) => one.kind)).toEqual([
          "create",
          "update",
          "delete"
        ])
        expect(seen.map((one) => one.seq)).toEqual([1, 2, 3])
        expect(seen.map((one) => one.id)).toEqual(["p1", "p1", "p1"])
      })
    ))

  it("records nothing for a purge", () =>
    held((db) =>
      Effect.gen(function* () {
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        yield* db.purge("Patient", "p1")
        expect(yield* db.feed.head).toBe(1)
      })
    ))

  it("supplies the store contract as a layer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Versions
        yield* db.insertVersion(entry("p1", 1, "Simpson"))
        expect((yield* db.current("Patient", "p1"))?.versionId).toBe(1)
      }).pipe(Effect.provide(layer(":memory:")))
    ))
})
