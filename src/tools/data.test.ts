import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import { connect, rows } from "./db.js"
import { migrate } from "./migrate.js"
import { exportLines, importLines, rebuild, run } from "./data.js"
import { writeText } from "./io.js"

interface Bench {
  readonly connection: DuckDBConnection
  readonly store: Versioned
}

const withStore = <A>(use: (bench: Bench) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(":memory:")
        yield* migrate(connection, "latest", false)
        const store = yield* versionedOn(connection)
        return yield* Effect.promise(() => use({ connection, store }))
      })
    )
  )

const go = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const patient = (id: string, family: string) =>
  JSON.stringify({ resourceType: "Patient", id, name: [{ family }] })

const seed = (bench: Bench, lines: ReadonlyArray<string>) =>
  go(importLines(bench.connection, lines, { replace: false, force: false }))

const scratch = () => mkdtemp(join(tmpdir(), "tools-data-"))

const started = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  Effect.runPromiseExit(Effect.scoped(run(argv, env)))

const imported = (path: string, store: string) =>
  started(["import", "--in", path], { FHIR_STORE_PATH: store })

describe("import", () => {
  it("writes every row it read", () =>
    withStore(async (bench) => {
      const report = await seed(bench, [patient("p1", "Simpson"), patient("p2", "Flanders")])
      expect(report).toMatchObject({ read: 2, written: 2, skipped: 0, problems: [] })
      const found = await go(bench.store.current("Patient", "p1"))
      expect(found?.body["resourceType"]).toBe("Patient")
    }))

  it("skips blank rows without counting them", () =>
    withStore(async (bench) => {
      const report = await seed(bench, [patient("p1", "Simpson"), "", "   "])
      expect(report.read).toBe(1)
      expect(report.written).toBe(1)
    }))

  it("adds a version when the same id is imported again", () =>
    withStore(async (bench) => {
      await seed(bench, [patient("p1", "Simpson")])
      await seed(bench, [patient("p1", "Simpsons")])
      const found = await go(bench.store.current("Patient", "p1"))
      expect(found?.versionId).toBe(2)
    }))

  it("reports a broken row by its position", () =>
    withStore(async (bench) => {
      const report = await seed(bench, [patient("p1", "Simpson"), "{not json"])
      expect(report.written).toBe(1)
      expect(report.skipped).toBe(1)
      expect(report.problems[0]).toContain("line 2")
      expect(report.problems[0]).toContain("json")
    }))

  it("reports a row with no type and a row with no id", () =>
    withStore(async (bench) => {
      const report = await seed(bench, [
        JSON.stringify({ id: "x" }),
        JSON.stringify({ resourceType: "Patient" })
      ])
      expect(report.problems).toHaveLength(2)
      expect(report.problems[0]).toContain("line 1")
      expect(report.problems[1]).toContain("line 2")
      expect(report.problems[1]).toContain("id")
    }))

  it("reports a row whose type the store does not carry", () =>
    withStore(async (bench) => {
      const report = await seed(bench, [JSON.stringify({ resourceType: "Vehicle", id: "v1" })])
      expect(report.problems[0]).toContain("unsupported resource type: Vehicle")
    }))

  it("refuses to replace what is stored without the flag", () =>
    withStore(async (bench) => {
      const exit = await Effect.runPromiseExit(
        importLines(bench.connection, [patient("p1", "Simpson")], { replace: true, force: false })
      )
      if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
      expect(exit.cause.error.message).toContain("--force")
    }))

  it("replaces the history of a resource once forced", () =>
    withStore(async (bench) => {
      await seed(bench, [patient("p1", "Simpson")])
      await seed(bench, [patient("p1", "Simpsons")])
      await go(
        importLines(bench.connection, [patient("p1", "Bouvier")], { replace: true, force: true })
      )
      const history = await go(bench.store.history("Patient", "p1"))
      expect(history).toHaveLength(1)
      expect(history[0]?.versionId).toBe(1)
    }))
})

describe("export", () => {
  it("writes one line per current resource in a stable order", () =>
    withStore(async (bench) => {
      await seed(bench, [patient("p2", "Flanders"), patient("p1", "Simpson")])
      const lines = await go(exportLines(bench.connection, undefined))
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["p1", "p2"])
    }))

  it("keeps only the type it was asked for", () =>
    withStore(async (bench) => {
      await seed(bench, [
        patient("p1", "Simpson"),
        JSON.stringify({ resourceType: "Observation", id: "o1", status: "final" })
      ])
      const lines = await go(exportLines(bench.connection, "Observation"))
      expect(lines).toHaveLength(1)
      expect((JSON.parse(lines[0] ?? "") as { id: string }).id).toBe("o1")
    }))

  it("leaves out what was deleted", () =>
    withStore(async (bench) => {
      await seed(bench, [patient("p1", "Simpson")])
      await go(bench.store.markDeleted("Patient", "p1", 2, "2024-01-01T00:00:00.000Z"))
      expect(await go(exportLines(bench.connection, undefined))).toEqual([])
    }))

  it("refuses a type the store does not carry", () =>
    withStore(async (bench) => {
      const exit = await Effect.runPromiseExit(exportLines(bench.connection, "Vehicle"))
      if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
      expect(exit.cause.error._tag).toBe("Rejected")
    }))
})

describe("rebuild", () => {
  it("refuses to drop the index without the flag", () =>
    withStore(async (bench) => {
      const exit = await Effect.runPromiseExit(rebuild(bench.connection, false))
      if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
      expect(exit.cause.error.message).toBe("refusing to rebuild the index without --force")
    }))

  it("restores search after the index is lost", () =>
    withStore(async (bench) => {
      await seed(bench, [patient("p1", "Simpson")])
      await go(rows(bench.connection, "delete from resource_index"))
      expect(await go(bench.store.matching("Patient", [["family", "Simpson"]]))).toHaveLength(0)
      const report = await go(rebuild(bench.connection, true))
      expect(report.resources).toBe(1)
      expect(report.entries).toBeGreaterThan(0)
      expect(await go(bench.store.matching("Patient", [["family", "Simpson"]]))).toHaveLength(1)
    }))

  it("does not double the index when it is rebuilt twice", () =>
    withStore(async (bench) => {
      await seed(bench, [patient("p1", "Simpson")])
      const first = await go(rebuild(bench.connection, true))
      const second = await go(rebuild(bench.connection, true))
      expect(second.entries).toBe(first.entries)
    }))
})

describe("data commands", () => {
  it("imports from a file and reports what it did", async () => {
    const dir = await scratch()
    const path = join(dir, "in.ndjson")
    await go(writeText(path, [patient("p1", "Simpson"), patient("p2", "Flanders")].join("\n")))
    const store = join(dir, "state.duckdb")
    await imported(path, store)
    const exit = await started(["export", "--out", join(dir, "out.ndjson")], {
      FHIR_STORE_PATH: store
    })
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({ action: "export", exported: 2 })
    expect((await readFile(join(dir, "out.ndjson"), "utf8")).trim().split("\n")).toHaveLength(2)
  })

  it("writes the export to the output when no file is named", async () => {
    const dir = await scratch()
    const path = join(dir, "in.ndjson")
    await go(writeText(path, patient("p1", "Simpson")))
    const store = join(dir, "state.duckdb")
    await imported(path, store)
    const exit = await started(["export"], { FHIR_STORE_PATH: store })
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.lines).toHaveLength(1)
    expect((JSON.parse(exit.value.lines[0] ?? "") as { id: string }).id).toBe("p1")
  })

  it("ends with a failing status when a row could not be read", async () => {
    const dir = await scratch()
    const path = join(dir, "in.ndjson")
    await go(writeText(path, "{not json"))
    const exit = await started(["import", "--in", path])
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.status).toBe(1)
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({ read: 1, written: 0 })
  })

  it("rebuilds through the command once forced", async () => {
    const dir = await scratch()
    const store = join(dir, "state.duckdb")
    const path = join(dir, "in.ndjson")
    await go(writeText(path, patient("p1", "Simpson")))
    await imported(path, store)
    const exit = await started(["rebuild", "--force"], { FHIR_STORE_PATH: store })
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(JSON.parse(exit.value.lines[0] ?? "")).toMatchObject({ action: "rebuild", resources: 1 })
  })

  it("refuses a rebuild through the command without the flag", async () => {
    const exit = await started(["rebuild"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--force")
  })

  it("refuses an import with no source", async () => {
    const exit = await started(["import"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("--in")
  })

  it("refuses a verb it does not know", async () => {
    const exit = await started(["reindex"])
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toContain("import")
  })
})
