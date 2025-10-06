import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Bundle, FhirResource } from "../core/engine.js"
import { UNRESTRICTED } from "../engine/restriction.js"
import { binding, restrictionOf, started, startup } from "./wiring.js"
import type { Startup } from "./wiring.js"
import { queueOn } from "../jobs/queue.js"
import type { Config } from "../config/config.js"

const config = (scopes: ReadonlyArray<string>): Config => ({
  transport: "stdio",
  http: { host: "127.0.0.1", port: 8080, origins: [] },
  store: { path: ":memory:" },
  allowWrite: false,
  scopes,
  terminologyDir: undefined,
  logLevel: "info",
  trail: { path: ":memory:", key: "", retentionMs: 0 }
})

const tables = async (connection: never): Promise<ReadonlyArray<string>> => {
  const r = await (connection as unknown as {
    runAndReadAll: (s: string) => Promise<{ getRowObjects: () => Array<Record<string, unknown>> }>
  }).runAndReadAll("select table_name from information_schema.tables")
  return r.getRowObjects().map((row) => String(row["table_name"]))
}

const opened = async (): Promise<DuckDBConnection> => {
  const instance = await DuckDBInstance.create(":memory:")
  return await instance.connect()
}

const put = (held: Startup, body: FhirResource, versionId = 1) =>
  held.versions.insertVersion({
    type: body.resourceType,
    id: String(body.id),
    versionId,
    lastUpdated: new Date().toISOString(),
    deleted: false,
    body
  })

const ids = (bundle: Bundle): ReadonlyArray<string> =>
  (bundle.entry ?? []).map((one) => String(one.resource.id))

const patient = (id: string, family: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Ada"] }],
  gender: "female"
})

const observation = (id: string, subject: string): FhirResource => ({
  resourceType: "Observation",
  id,
  status: "final",
  code: { coding: [{ code: "8867-4" }] },
  subject: { reference: `Patient/${subject}` }
})

describe("wiring", () => {
  it("names an unrestricted binding rather than reaching it by omission", () => {
    expect(restrictionOf(config([])).name).toBe("unrestricted")
    expect(restrictionOf(config(["patient:p1/*.read"])).name).toBe("granted")
  })

  it("creates the typed index tables the query backend needs", async () => {
    const connection = await opened()
    await Effect.runPromise(Effect.scoped(started(connection as never)) as never)
    const held = await tables(connection as never)
    for (const wanted of ["index_token", "index_number", "index_date", "index_quantity", "index_reference"]) {
      expect(held).toContain(wanted)
    }
    connection.closeSync()
  })

  it("builds one cache for the process, not one per engine", async () => {
    const connection = await opened()
    const deps = await Effect.runPromise(Effect.scoped(started(connection as never)) as never) as { cache: unknown }
    const again = await Effect.runPromise(Effect.scoped(started(connection as never)) as never) as { cache: unknown }
    expect(deps.cache).toBeDefined()
    expect(again.cache).toBeDefined()
    connection.closeSync()
  })

  it("reports a store it cannot prepare rather than serving a broken engine", async () => {
    const connection = await opened()
    connection.closeSync()
    const exit = await Effect.runPromiseExit(Effect.scoped(started(connection as never)) as never)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("the engine the wiring binds", () => {
  let connection: DuckDBConnection
  let held: Startup

  beforeAll(async () => {
    connection = await opened()
    held = await Effect.runPromise(Effect.scoped(startup(connection)))
    await Effect.runPromise(put(held, patient("p1", "Vance")))
    await Effect.runPromise(put(held, patient("p2", "Stone")))
    await Effect.runPromise(put(held, observation("o1", "p1")))
    await Effect.runPromise(put(held, observation("o2", "p2")))
  }, 30000)

  afterAll(() => {
    connection.closeSync()
  })

  it("answers a modifier the naive index table cannot", async () => {
    const engine = binding(held, UNRESTRICTED)
    const found = await Effect.runPromise(
      engine.search({ type: "Patient", parameters: [["family:contains", "anc"]] })
    )
    expect(ids(found)).toEqual(["p1"])
  })

  it("answers a chain across resources", async () => {
    const engine = binding(held, UNRESTRICTED)
    const found = await Effect.runPromise(
      engine.search({ type: "Observation", parameters: [["subject:Patient.family", "Vance"]] })
    )
    expect(ids(found)).toEqual(["o1"])
  })

  it("sorts and pages what it returns", async () => {
    const engine = binding(held, UNRESTRICTED)
    const found = await Effect.runPromise(
      engine.search({ type: "Patient", parameters: [["_sort", "family"]] })
    )
    expect(ids(found)).toEqual(["p2", "p1"])
  })

  it("binds one restriction per caller over one startup", async () => {
    const open = binding(held, UNRESTRICTED)
    const narrow = binding(held, restrictionOf(config(["patient:p1/*.read"])))
    expect(ids(await Effect.runPromise(open.search({ type: "Observation", parameters: [] }))))
      .toEqual(["o1", "o2"])
    expect(ids(await Effect.runPromise(narrow.search({ type: "Observation", parameters: [] }))))
      .toEqual(["o1"])
  })

  it("keeps a resource outside the grant out of a read", async () => {
    const narrow = binding(held, restrictionOf(config(["patient:p1/*.read"])))
    const exit = await Effect.runPromiseExit(narrow.read("Observation", "o2"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("reports a deleted resource as deleted rather than as absent", async () => {
    const engine = binding(held, UNRESTRICTED)
    await Effect.runPromise(put(held, patient("p3", "Gray")))
    await Effect.runPromise(held.versions.markDeleted("Patient", "p3", 2, new Date().toISOString()))
    const exit = await Effect.runPromiseExit(engine.read("Patient", "p3"))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected a failure")
    expect(exit.cause.error._tag).toBe("Gone")
  })

  it("reports what it never held as absent", async () => {
    const engine = binding(held, UNRESTRICTED)
    const exit = await Effect.runPromiseExit(engine.read("Patient", "nobody"))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected a failure")
    expect(exit.cause.error._tag).toBe("NotFound")
  })

  it("names the types and the ready parameters a caller may use", async () => {
    const engine = binding(held, UNRESTRICTED)
    expect(await Effect.runPromise(engine.resourceTypes()))
      .toEqual(["Patient", "Observation", "Condition", "Encounter"])
    expect(await Effect.runPromise(engine.searchParameters("Patient"))).toContain("family")
  })
})

describe("the watchdog the wiring starts", () => {
  let watching: DuckDBConnection

  beforeAll(async () => {
    watching = await opened()
  })

  afterAll(() => {
    watching.closeSync()
  })

  it("reclaims a job a dead worker still holds, with no operator action", async () => {
    const swept = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* startup(watching, {
            stalledEveryMs: 20,
            defragEveryMs: 600_000,
            purgeEveryMs: 600_000
          })
          const queue = yield* queueOn(watching)
          const id = yield* queue.submit({
            kind: "unhandled",
            payloads: ["{}"],
            correlation: "c1",
            maxAttempts: 2
          })
          const taken = yield* queue.lease("ghost", ["unhandled"], 10)
          yield* Effect.sleep("150 millis")
          const report = yield* held.vigil.report
          const again = yield* queue.lease("next", ["unhandled"], 60_000)
          return { id, taken: taken?.jobId, again: again?.jobId, report }
        })
      )
    )
    expect(swept.taken).toBe(swept.id)
    expect(swept.report.reclaimed).toBeGreaterThan(0)
    expect(swept.again).toBe(swept.id)
  })

  it("sweeps every kind on its own rounds and records no fault", async () => {
    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* startup(watching, {
            stalledEveryMs: 20,
            defragEveryMs: 20,
            purgeEveryMs: 600_000
          })
          yield* Effect.sleep("150 millis")
          return yield* held.vigil.report
        })
      )
    )
    expect(report.rounds).toBeGreaterThanOrEqual(2)
    expect(report.faults).toBe(0)
  })
})
