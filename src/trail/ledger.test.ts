import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { Scope } from "effect"
import type { Entry } from "../agent/audit.js"
import type { Failure } from "../core/outcome.js"
import type { Trail } from "./store.js"
import { open } from "./store.js"
import { addressed, asJournal, asLine } from "./ledger.js"

const entry = (over: Partial<Entry> = {}): Entry => ({
  at: "2026-01-01T00:00:00.000Z",
  correlation: "c-1",
  actor: "anonymous",
  tool: "create",
  interaction: "create",
  outcome: "success",
  ...over
})

const withTrail = <A>(
  use: (trail: Trail) => Effect.Effect<A, Failure, Scope.Scope>
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(open(":memory:"), use)))

describe("an audit entry reaching the trail", () => {
  it("names the resource it touched by type and id", () => {
    expect(addressed(entry({ type: "Patient", id: "p1" }))).toBe("Patient/p1")
  })

  it("names a resource it touched by type alone when no id is carried", () => {
    expect(addressed(entry({ type: "Patient" }))).toBe("Patient")
  })

  it("names no resource when the entry carries no type", () => {
    expect(addressed(entry())).toBe("other")
  })

  it("carries the interaction as the action and the verdict as the outcome", () => {
    const line = asLine(entry({ interaction: "search", outcome: "refused" }))
    expect(line.action).toBe("search")
    expect(line.outcome).toBe("refused")
  })

  it("appends one numbered line per entry", async () => {
    const lines = await withTrail((trail) =>
      Effect.gen(function* () {
        const journal = asJournal(trail)
        yield* journal.note(entry())
        yield* journal.note(entry({ id: "p1", type: "Patient" }))
        return yield* trail.lines
      })
    )
    expect(lines.map((line) => line.seq)).toEqual([1, 2])
    expect(lines[0]?.prev).toBe("0".repeat(64))
    expect(lines[1]?.prev).toBe(lines[0]?.digest)
  })

  it("verifies as intact after a run of entries", async () => {
    const report = await withTrail((trail) =>
      Effect.gen(function* () {
        const journal = asJournal(trail)
        yield* journal.note(entry())
        yield* journal.note(entry({ type: "Observation" }))
        return yield* trail.verify("k")
      })
    )
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(2)
    expect(report.head).toBe(2)
  })

  it("stays verifiable after a retention purge empties it", async () => {
    const found = await withTrail((trail) =>
      Effect.gen(function* () {
        const journal = asJournal(trail)
        yield* journal.note(entry())
        yield* journal.note(entry({ type: "Patient", id: "p1" }))
        const removed = yield* trail.purge("k", 0)
        const report = yield* trail.verify("k")
        return { removed, report }
      })
    )
    expect(found.removed).toBe(2)
    expect(found.report.ok).toBe(true)
    expect(found.report.checked).toBe(0)
  })

  it("keeps the records newer than the retention it was given", async () => {
    const kept = await withTrail((trail) =>
      Effect.gen(function* () {
        const journal = asJournal(trail)
        yield* journal.note(entry())
        yield* trail.purge("k", 3_600_000)
        return yield* trail.lines
      })
    )
    expect(kept).toHaveLength(1)
  })

  it("exports every line it holds", async () => {
    const text = await withTrail((trail) =>
      Effect.gen(function* () {
        const journal = asJournal(trail)
        yield* journal.note(entry({ type: "Patient", id: "p1" }))
        return yield* trail.dump
      })
    )
    expect(text).toContain("Patient/p1")
    expect(text).toContain("c-1")
  })
})
