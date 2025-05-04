import { describe, expect, it } from "vitest"
import { Effect, Exit, TestClock, TestContext } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Failure } from "../core/outcome.js"
import { audit, read } from "./chain.js"
import type { Entry } from "./chain.js"
import { open, trailOn } from "./store.js"
import type { Trail } from "./store.js"

const KEY = "a-key-kept-outside-the-trail"

const entry = (n: number): Entry => ({
  actor: `actor-${n}`,
  action: "read",
  resource: `Patient/${n}`,
  outcome: "success",
  correlation: `c-${n}`
})

const wired = <A>(
  work: (trail: Trail, sql: DuckDBConnection) => Effect.Effect<A, Failure>
): Promise<A> =>
  Effect.runPromise(
    Effect.promise(async () => {
      const instance = await DuckDBInstance.create(":memory:")
      return await instance.connect()
    }).pipe(
      Effect.flatMap((connection) =>
        Effect.flatMap(trailOn(connection), (trail) =>
          work(trail, connection)
        )
      ),
      Effect.provide(TestContext.TestContext)
    )
  )

const broke = <A>(
  work: (trail: Trail, sql: DuckDBConnection) => Effect.Effect<A, Failure>
) =>
  Effect.runPromiseExit(
    Effect.promise(async () => {
      const instance = await DuckDBInstance.create(":memory:")
      return await instance.connect()
    }).pipe(
      Effect.flatMap((connection) =>
        Effect.flatMap(trailOn(connection), (trail) =>
          work(trail, connection)
        )
      ),
      Effect.provide(TestContext.TestContext)
    )
  ).then((result) => {
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      return result.cause.error._tag
    }
    throw new Error("expected a failure")
  })

const run = (sql: DuckDBConnection, text: string) =>
  Effect.promise(async () => {
    await sql.run(text)
  })

const fill = (trail: Trail, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, n) => n + 1),
    (n) => trail.append(entry(n)),
    { discard: true }
  )

describe("trail store", () => {
  it("chains what it appends", () =>
    wired((trail) =>
      Effect.gen(function* () {
        const first = yield* trail.append(entry(1))
        const second = yield* trail.append(entry(2))
        expect(first.seq).toBe(1)
        expect(second.seq).toBe(2)
        expect(second.prev).toBe(first.digest)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(true)
        expect(report.checked).toBe(2)
        expect(report.head).toBe(2)
      })
    ))

  it("verifies an empty trail", () =>
    wired((trail) =>
      Effect.map(trail.verify(KEY), (report) => {
        expect(report.ok).toBe(true)
        expect(report.checked).toBe(0)
      })
    ))

  it("names the record whose content was altered", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 4)
        yield* run(
          sql,
          `update trail_line set resource = 'Patient/999' where seq = 2`
        )
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(false)
        expect(report.broke?.seq).toBe(2)
        expect(report.broke?.cause).toBe("content")
      })
    ))

  it("names the record left without its predecessor", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 4)
        yield* run(sql, `delete from trail_line where seq = 2`)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(false)
        expect(report.broke?.seq).toBe(3)
        expect(report.broke?.cause).toBe("missing")
      })
    ))

  it("names both records when two are reordered", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 4)
        yield* run(sql, `update trail_line set seq = 99 where seq = 2`)
        yield* run(sql, `update trail_line set seq = 2 where seq = 3`)
        yield* run(sql, `update trail_line set seq = 3 where seq = 99`)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(false)
        expect(report.broke?.cause).toBe("order")
        expect(report.broke?.seq).toBe(2)
        expect(report.broke?.detail).toContain("3")
      })
    ))

  it("cannot see an end truncation on its own", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 4)
        yield* run(sql, `delete from trail_line where seq > 2`)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(true)
        expect(report.head).toBe(2)
      })
    ))

  it("sees an end truncation once the head is sealed", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 4)
        const seal = yield* trail.seal(KEY)
        expect(seal.seq).toBe(4)
        yield* run(sql, `delete from trail_line where seq > 2`)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(false)
        expect(report.broke?.seq).toBe(4)
        expect(report.broke?.cause).toBe("truncated")
      })
    ))

  it("still cannot see records dropped after the last seal", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 2)
        yield* trail.seal(KEY)
        yield* fill(trail, 2)
        yield* run(sql, `delete from trail_line where seq > 2`)
        expect((yield* trail.verify(KEY)).ok).toBe(true)
      })
    ))

  it("refuses a seal forged without the key", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* run(
          sql,
          `insert into trail_seal values (3, 'x', 0, 'deadbeef')`
        )
        const report = yield* trail.verify(KEY)
        expect(report.broke?.cause).toBe("seal")
      })
    ))

  it("refuses to seal an empty trail", () =>
    expect(broke((trail) => trail.seal(KEY))).resolves.toBe("Rejected"))

  it("keeps verification working after retention purges a prefix", () =>
    wired((trail) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* TestClock.adjust(10_000)
        yield* fill(trail, 2)
        expect(yield* trail.purge(KEY, 5_000)).toBe(3)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(true)
        expect(report.checked).toBe(2)
        const lines = yield* trail.lines
        expect(lines[0]?.seq).toBe(4)
      })
    ))

  it("purges nothing when nothing is past retention", () =>
    wired((trail) =>
      Effect.gen(function* () {
        yield* fill(trail, 2)
        expect(yield* trail.purge(KEY, 60_000)).toBe(0)
        expect((yield* trail.verify(KEY)).ok).toBe(true)
      })
    ))

  it("carries the sequence and the chain across a full purge", () =>
    wired((trail) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* TestClock.adjust(10_000)
        expect(yield* trail.purge(KEY, 1_000)).toBe(3)
        const next = yield* trail.append(entry(9))
        expect(next.seq).toBe(4)
        expect((yield* trail.verify(KEY)).ok).toBe(true)
      })
    ))

  it("shows a purge that was not made with the key", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* TestClock.adjust(10_000)
        yield* fill(trail, 1)
        yield* trail.purge(KEY, 5_000)
        yield* run(sql, `update trail_anchor set mac = 'deadbeef'`)
        expect((yield* trail.verify(KEY)).broke?.cause).toBe("anchor")
      })
    ))

  it("drops a seal the purge left behind and keeps the pin", () =>
    wired((trail) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* trail.seal(KEY)
        yield* TestClock.adjust(10_000)
        yield* fill(trail, 2)
        yield* trail.seal(KEY)
        expect(yield* trail.purge(KEY, 5_000)).toBe(3)
        const report = yield* trail.verify(KEY)
        expect(report.ok).toBe(true)
      })
    ))

  it("exports a trail that verifies away from the store", () =>
    wired((trail) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* trail.seal(KEY)
        const text = yield* trail.dump
        expect(text.split("\n")).toHaveLength(4)
        expect(audit(KEY, read(text)).ok).toBe(true)
      })
    ))

  it("exports an edit made in the store", () =>
    wired((trail, sql) =>
      Effect.gen(function* () {
        yield* fill(trail, 3)
        yield* run(
          sql,
          `update trail_line set actor = 'someone-else' where seq = 1`
        )
        const text = yield* trail.dump
        expect(audit(KEY, read(text)).broke?.seq).toBe(1)
      })
    ))

  it("opens a trail of its own and chains what it holds", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(open(":memory:"), (trail) =>
          Effect.gen(function* () {
            yield* trail.append(entry(1))
            yield* trail.append(entry(2))
            expect((yield* trail.verify(KEY)).checked).toBe(2)
          })
        )
      ).pipe(Effect.provide(TestContext.TestContext))
    ))

  it("reports the store as unavailable when a query cannot run", () =>
    expect(
      broke((trail, sql) =>
        Effect.zipRight(
          Effect.promise(async () => {
            await sql.run(`drop table trail_line`)
          }),
          trail.append(entry(1))
        )
      )
    ).resolves.toBe("Unavailable"))
})
