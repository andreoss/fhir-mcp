import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Failure } from "../core/outcome.js"
import { queueOn } from "../jobs/queue.js"
import type { Durable } from "../jobs/queue.js"
import { desk } from "../jobs/service.js"
import { KINDS, kindsOf } from "../jobs/types.js"
import type { Registry } from "../jobs/types.js"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import { depotOn } from "./depot.js"
import type { Depot } from "./depot.js"
import { handlers, report } from "./bulk.js"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

interface Bench {
  readonly store: Versioned
  readonly depot: Depot
  readonly queue: Durable
  readonly held: Registry
}

const bench = <A>(
  work: (given: Bench) => Effect.Effect<A, Failure>
): Promise<A> =>
  Effect.runPromise(
    Effect.promise(async () => {
      const instance = await DuckDBInstance.create(":memory:")
      return await instance.connect()
    }).pipe(
      Effect.flatMap((connection: DuckDBConnection) =>
        Effect.gen(function* () {
          const store = yield* versionedOn(connection)
          const depot = yield* depotOn(connection)
          const queue = yield* queueOn(connection)
          return yield* work({
            store,
            depot,
            queue,
            held: handlers(store, depot)
          })
        })
      )
    )
  )

describe("the bulk registry", () => {
  it("registers a handler for every job kind the machinery knows", () =>
    bench((given) =>
      Effect.sync(() => {
        expect([...kindsOf(given.held)].sort()).toEqual([...KINDS].sort())
      })
    ))

  it("submits every kind through the one job desk", () =>
    bench((given) =>
      Effect.gen(function* () {
        const counter = desk(given.queue, given.held)
        const asked: Readonly<Record<string, string>> = {
          export: JSON.stringify({ scope: { kind: "system" } }),
          import: JSON.stringify({
            input: [{ type: "Patient", path: "in/none.ndjson" }]
          }),
          "bulk-delete": JSON.stringify({ type: "Patient" }),
          "bulk-update": JSON.stringify({
            patch: { kind: "json", ops: [] }
          }),
          reindex: JSON.stringify({})
        }
        for (const kind of KINDS) {
          const ticket = yield* counter.submit(kind, asked[kind] ?? "{}")
          const status = yield* counter.status(ticket.id)
          expect(status.kind).toBe(kind)
          expect(status.state).toBe("queued")
          expect(ticket.location).toBe(`/jobs/${ticket.id}`)
        }
      })
    ))

  it("accounts for a job no unit has run yet", () =>
    bench((given) =>
      Effect.gen(function* () {
        const counter = desk(given.queue, given.held)
        const ticket = yield* counter.submit(
          "reindex",
          JSON.stringify({ type: "Patient" })
        )
        const account = yield* report(counter, given.depot, ticket.id)
        expect(account.job).toBe(ticket.id)
        expect(account.kind).toBe("reindex")
        expect(account.output).toEqual([])
        expect(account.error).toBeUndefined()
        expect(account.rules).toBeUndefined()
        expect(account.detail).toBe(
          "reindex: 0/1 units, 0 written, 0 skipped, 0 failed"
        )
      })
    ))

  it("cancels a job it submitted", () =>
    bench((given) =>
      Effect.gen(function* () {
        const counter = desk(given.queue, given.held)
        const ticket = yield* counter.submit("reindex", "{}")
        yield* counter.cancel(ticket.id)
        const account = yield* report(counter, given.depot, ticket.id)
        expect(account.state).toBe("cancelled")
        expect(account.progress.pending).toBe(0)
        expect(account.progress.done).toBe(0)
      })
    ))
})
