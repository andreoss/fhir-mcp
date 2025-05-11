import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import type { Failure } from "../core/outcome.js"
import { changeOf, open } from "./feed.js"
import type { Entry, Feed } from "./feed.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const held = <A>(use: (feed: Feed) => Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(open(":memory:"), use)))

const at = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const entry = (id: string, versionId: number, deleted = false): Entry => ({
  type: "Patient",
  id,
  versionId,
  kind: changeOf(versionId, deleted),
  at: at(versionId)
})

describe("change feed", () => {
  it("starts empty", () =>
    held((feed) =>
      Effect.gen(function* () {
        expect(yield* feed.head).toBe(0)
        expect(yield* feed.since(0)).toEqual([])
      })
    ))

  it("names a change from the version and the delete marker", () => {
    expect(changeOf(1, false)).toBe("create")
    expect(changeOf(2, false)).toBe("update")
    expect(changeOf(9, true)).toBe("delete")
    expect(changeOf(1, true)).toBe("delete")
  })

  it("records one ordered entry per create, update and delete", () =>
    held((feed) =>
      Effect.gen(function* () {
        expect(yield* feed.append(entry("p1", 1))).toBe(1)
        expect(yield* feed.append(entry("p1", 2))).toBe(2)
        expect(yield* feed.append(entry("p1", 3, true))).toBe(3)
        const seen = yield* feed.since(0)
        expect(seen.map((one) => one.seq)).toEqual([1, 2, 3])
        expect(seen.map((one) => one.kind)).toEqual([
          "create",
          "update",
          "delete"
        ])
        expect(seen.map((one) => one.versionId)).toEqual([1, 2, 3])
        expect(seen[0]?.at).toBe(at(1))
        expect(seen[0]?.type).toBe("Patient")
        expect(seen[0]?.id).toBe("p1")
        expect(yield* feed.head).toBe(3)
      })
    ))

  it("records one entry when the same version is appended twice", () =>
    held((feed) =>
      Effect.gen(function* () {
        const first = yield* feed.append(entry("p1", 1))
        const again = yield* feed.append(entry("p1", 1))
        expect(again).toBe(first)
        expect(yield* feed.head).toBe(1)
        expect((yield* feed.since(0)).length).toBe(1)
      })
    ))

  it("replays only what follows a cursor", () =>
    held((feed) =>
      Effect.gen(function* () {
        yield* Effect.forEach([1, 2, 3, 4], (n) => feed.append(entry("p1", n)))
        expect((yield* feed.since(2)).map((one) => one.seq)).toEqual([3, 4])
        expect((yield* feed.since(0, 2)).map((one) => one.seq)).toEqual([1, 2])
        expect(yield* feed.since(4)).toEqual([])
      })
    ))

  it("leaves no gaps and no duplicates under concurrent writes", () =>
    held((feed) =>
      Effect.gen(function* () {
        const writes = Array.from({ length: 60 }, (_, at) => at)
        yield* Effect.forEach(
          writes,
          (n) => feed.append(entry(`p${n % 6}`, Math.floor(n / 6) + 1)),
          { concurrency: "unbounded", discard: true }
        )
        const seen = yield* feed.since(0)
        expect(seen.length).toBe(60)
        expect(yield* feed.head).toBe(60)
        expect(seen.map((one) => one.seq)).toEqual(
          writes.map((n) => n + 1)
        )
        const keys = new Set(
          seen.map((one) => `${one.type}/${one.id}/${one.versionId}`)
        )
        expect(keys.size).toBe(60)
      })
    ))

  it("records one entry per version when writes are retried", () =>
    held((feed) =>
      Effect.gen(function* () {
        const writes = Array.from({ length: 30 }, (_, at) => at)
        yield* Effect.forEach(
          writes,
          (n) => feed.append(entry(`p${n % 10}`, Math.floor(n / 10) + 1)),
          { concurrency: "unbounded", discard: true }
        )
        yield* Effect.forEach(
          writes,
          (n) => feed.append(entry(`p${n % 10}`, Math.floor(n / 10) + 1)),
          { concurrency: "unbounded", discard: true }
        )
        expect(yield* feed.head).toBe(30)
        expect((yield* feed.since(0)).length).toBe(30)
      })
    ))
})
