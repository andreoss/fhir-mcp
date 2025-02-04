import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { Failure } from "../core/outcome.js"
import { edge } from "../obs/correlation.js"
import type { Entry } from "./chain.js"
import { trailOn } from "./store.js"
import { desk } from "./jobs.js"
import type { Desk, Grant } from "./jobs.js"

const KEY = "a-key-kept-outside-the-trail"

const ada: Grant = {
  subject: "ada",
  actions: ["export", "reindex"],
  types: ["Patient", "Observation"]
}

const bob: Grant = {
  subject: "bob",
  actions: ["export"],
  types: ["Patient"]
}

const kept = (): {
  readonly sink: (entry: Entry) => Effect.Effect<void>
  readonly seen: Array<Entry>
} => {
  const seen: Array<Entry> = []
  return {
    sink: (entry: Entry) => Effect.sync(() => void seen.push(entry)),
    seen
  }
}

const run = <A>(work: Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(edge(work, "c-1"))

const broke = <A>(work: Effect.Effect<A, Failure>) =>
  Effect.runPromiseExit(edge(work, "c-1")).then((result) => {
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      return result.cause.error
    }
    throw new Error("expected a failure")
  })

const withDesk = <A>(use: (jobs: Desk) => Effect.Effect<A, Failure>) => {
  const held = kept()
  return { held, work: use(desk(held.sink)) }
}

describe("job scope", () => {
  it("takes a submission the grant covers", () =>
    run(
      Effect.gen(function* () {
        const held = kept()
        const jobs = desk(held.sink)
        const slip = yield* jobs.submit(ada, {
          action: "export",
          type: "Patient"
        })
        expect(slip.owner).toBe("ada")
        expect(slip.action).toBe("export")
        expect(held.seen[0]?.outcome).toBe("success")
        expect(held.seen[0]?.actor).toBe("ada")
        expect(held.seen[0]?.correlation).toBe("c-1")
      })
    ))

  it("refuses a submission whose action the grant lacks", async () => {
    const { held, work } = withDesk((jobs) =>
      jobs.submit(ada, { action: "import", type: "Patient" })
    )
    const failure = await broke(work)
    expect(failure._tag).toBe("Forbidden")
    expect(held.seen[0]?.outcome).toBe("refused")
  })

  it("refuses a submission whose type the grant lacks", async () => {
    const { work } = withDesk((jobs) =>
      jobs.submit(ada, { action: "export", type: "Encounter" })
    )
    expect((await broke(work))._tag).toBe("Forbidden")
  })

  it("takes any type when the grant carries the wildcard", () =>
    run(
      Effect.gen(function* () {
        const jobs = desk(kept().sink)
        const slip = yield* jobs.submit(
          { subject: "root", actions: ["export"], types: ["*"] },
          { action: "export", type: "Encounter" }
        )
        expect(slip.type).toBe("Encounter")
      })
    ))
})

describe("job result access", () => {
  it("gives the owner what its job produced", () =>
    run(
      Effect.gen(function* () {
        const jobs = desk(kept().sink)
        const slip = yield* jobs.submit(ada, {
          action: "export",
          type: "Patient"
        })
        yield* jobs.finish(slip.id, "ndjson-body")
        expect(yield* jobs.result(ada, slip.id)).toBe("ndjson-body")
      })
    ))

  it("refuses another caller the result of a job", async () => {
    const held = kept()
    const jobs = desk(held.sink)
    const slip = await run(
      jobs.submit(ada, { action: "export", type: "Patient" })
    )
    await run(jobs.finish(slip.id, "ndjson-body"))
    const failure = await broke(jobs.result(bob, slip.id))
    expect(failure._tag).toBe("Forbidden")
    const refusal = held.seen[held.seen.length - 1]
    expect(refusal?.outcome).toBe("refused")
    expect(refusal?.actor).toBe("bob")
    expect(refusal?.resource).toContain(slip.id)
  })

  it("refuses the owner whose grant no longer carries the action",
    async () => {
      const jobs = desk(kept().sink)
      const slip = await run(
        jobs.submit(ada, { action: "export", type: "Patient" })
      )
      await run(jobs.finish(slip.id, "ndjson-body"))
      const failure = await broke(
        jobs.result({ ...ada, actions: ["reindex"] }, slip.id)
      )
      expect(failure._tag).toBe("Forbidden")
    })

  it("reports a job it does not hold", async () => {
    const { work } = withDesk((jobs) => jobs.result(ada, "no-such-job"))
    expect((await broke(work))._tag).toBe("NotFound")
  })

  it("reports a job that has produced nothing yet", async () => {
    const jobs = desk(kept().sink)
    const slip = await run(
      jobs.submit(ada, { action: "export", type: "Patient" })
    )
    expect((await broke(jobs.result(ada, slip.id)))._tag).toBe("Conflict")
  })

  it("refuses to finish a job it does not hold", async () => {
    const { work } = withDesk((jobs) => jobs.finish("no-such-job", "body"))
    expect((await broke(work))._tag).toBe("NotFound")
  })
})

describe("job audit", () => {
  it("writes every refusal into a durable trail", async () => {
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    const trail = await Effect.runPromise(trailOn(connection))
    const jobs = desk(trail.append)
    await run(jobs.submit(ada, { action: "export", type: "Patient" }))
    await broke(jobs.submit(bob, { action: "reindex", type: "Patient" }))
    const report = await Effect.runPromise(trail.verify(KEY))
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(2)
    const lines = await Effect.runPromise(trail.lines)
    expect(lines[1]?.outcome).toBe("refused")
    expect(lines[1]?.actor).toBe("bob")
  })
})
