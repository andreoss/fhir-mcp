import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Versions } from "../core/interactions.js"
import type { Version, VersionedStore } from "../core/interactions.js"
import { fake } from "../replace/fake.js"
import { Incumbency } from "../replace/port.js"
import { Grant } from "./write.js"
import { REPLACE_RULES } from "./rules.js"
import { callReplace, replaceTools } from "./replace.js"

const instant = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const version = (type: string, id: string, at = 1, over: Record<string, unknown> = {}): Version => ({
  type,
  id,
  versionId: at,
  lastUpdated: instant(at),
  deleted: false,
  body: { resourceType: type, id, ...over }
})

const target = () => {
  const rows: Array<Version> = []
  const port: VersionedStore = {
    current: (type, id) =>
      Effect.sync(() =>
        [...rows]
          .filter((row) => row.type === type && row.id === id)
          .sort((a, b) => b.versionId - a.versionId)[0]
      ),
    versionAt: (type, id, versionId) =>
      Effect.sync(() =>
        rows.find((row) => row.type === type && row.id === id && row.versionId === versionId)
      ),
    history: (type, id) => Effect.sync(() => rows.filter((row) => row.type === type && row.id === id)),
    insertVersion: (entry) =>
      Effect.sync(() => {
        rows.push(entry)
      }),
    markDeleted: (type, id, versionId, lastUpdated) =>
      Effect.sync(() => {
        rows.push({ type, id, versionId, lastUpdated, deleted: true, body: { resourceType: type, id } })
      }),
    purge: () => Effect.void,
    matching: (type) => Effect.sync(() => rows.filter((row) => row.type === type && !row.deleted)),
    mint: (type) => Effect.succeed(`${type}-1`),
    stamp: () => Effect.succeed(instant(9))
  }
  return { port, rows }
}

const opened = (seed: ReadonlyArray<Version>, stale: ReadonlyArray<string> = []) =>
  Layer.succeed(Incumbency, () => Effect.succeed(fake(seed, stale)))

const held = (
  seed: ReadonlyArray<Version>,
  write: boolean,
  stale: ReadonlyArray<string> = []
) => {
  const made = target()
  return {
    rows: made.rows,
    layer: Layer.mergeAll(
      opened(seed, stale),
      Layer.succeed(Versions, made.port),
      Layer.succeed(Grant, { write, correlation: "c-1" })
    )
  }
}

const run = <A>(
  layer: Layer.Layer<Incumbency | Versions | Grant>,
  work: Effect.Effect<A, never, Incumbency | Versions | Grant>
) => Effect.runPromise(Effect.provide(work, layer))

const body = (found: { readonly content: ReadonlyArray<{ readonly text: string }> }): unknown =>
  JSON.parse(found.content[0]?.text ?? "{}")

describe("the replacement door on the served surface", () => {
  it("names the three tools it serves", () => {
    expect(replaceTools.map((tool) => tool.name)).toEqual([
      "replace-survey",
      "replace-migrate",
      "replace-shadow"
    ])
    for (const tool of replaceTools) expect(tool.description).toContain(REPLACE_RULES)
  })

  it("reads the schema, the types and the tally of the incumbent", async () => {
    const { layer } = held([version("Patient", "p1"), version("Patient", "p1", 2)], false)
    const found = await run(layer, callReplace("replace-survey", { path: "other.duckdb" }))
    expect(found.isError).toBe(false)
    const answer = body(found) as {
      schema: { version: number; table: ReadonlyArray<string> }
      types: ReadonlyArray<string>
      tally: { types: number; resources: number; versions: number }
      search: ReadonlyArray<{ name: string; ready: boolean }>
    }
    expect(answer.schema.version).toBe(7)
    expect(answer.schema.table).toContain("record")
    expect(answer.types).toEqual(["Patient"])
    expect(answer.tally).toEqual({ types: 1, resources: 1, versions: 2, deletes: 0 })
    expect(answer.search.some((one) => one.name === "family" && one.ready)).toBe(true)
  })

  it("names a search parameter the incumbent has not finished", async () => {
    const { layer } = held([version("Patient", "p1")], false, ["family"])
    const found = await run(layer, callReplace("replace-survey", { path: "other.duckdb" }))
    const answer = body(found) as { search: ReadonlyArray<{ name: string; ready: boolean }> }
    expect(answer.search.some((one) => one.name === "family" && one.ready === false)).toBe(true)
  })

  it("migrates every version into this store and accounts for it", async () => {
    const made = held([version("Patient", "p1"), version("Patient", "p1", 2)], true)
    const found = await run(made.layer, callReplace("replace-migrate", { path: "other.duckdb" }))
    expect((body(found) as { complete: boolean; written: number; verified: number }).complete).toBe(
      true
    )
    expect(made.rows).toHaveLength(2)
  })

  it("names the version that did not transfer", async () => {
    const made = held([{ ...version("Patient", "p1"), body: { resourceType: "Observation" } }], true)
    const found = await run(made.layer, callReplace("replace-migrate", { path: "other.duckdb" }))
    const answer = body(found) as { complete: boolean; missed: ReadonlyArray<string> }
    expect(answer.complete).toBe(false)
    expect(answer.missed).toEqual(["Patient/p1/_history/1"])
  })

  it("refuses a migration the grant does not cover", async () => {
    const made = held([version("Patient", "p1")], false)
    const found = await run(made.layer, callReplace("replace-migrate", { path: "other.duckdb" }))
    expect((found as { isError: boolean }).isError).toBe(true)
    expect(made.rows).toHaveLength(0)
  })

  it("serves the same read on both sides and passes the gate", async () => {
    const made = held([version("Patient", "p1")], true)
    await run(made.layer, callReplace("replace-migrate", { path: "other.duckdb" }))
    const found = await run(
      made.layer,
      callReplace("replace-shadow", {
        path: "other.duckdb",
        request: [{ kind: "read", type: "Patient", id: "p1" }]
      })
    )
    const answer = body(found) as {
      left: string
      right: string
      of: number
      gate: { pass: boolean; reason: ReadonlyArray<string> }
    }
    expect([answer.left, answer.right]).toEqual(["incumbent", "served"])
    expect(answer.of).toBe(1)
    expect(answer.gate.pass).toBe(true)
    expect(answer.gate.reason).toEqual([])
  })

  it("names a divergence and fails the gate when only one side answers", async () => {
    const made = held([version("Patient", "p1", 1, { name: [{ family: "Simpson" }] })], true)
    const found = await run(
      made.layer,
      callReplace("replace-shadow", {
        path: "other.duckdb",
        request: [
          { kind: "read", type: "Patient", id: "p1" },
          { kind: "search", type: "Patient", criteria: [["family", "Simpson"]] }
        ]
      })
    )
    const answer = body(found) as {
      byKind: Record<string, number>
      divergence: ReadonlyArray<{ kind: string; detail: string }>
      gate: { pass: boolean; reason: ReadonlyArray<string> }
    }
    expect(answer.byKind["only-left"]).toBe(2)
    expect(answer.divergence[0]?.detail).toContain("incumbent")
    expect(answer.gate.pass).toBe(false)
    expect(answer.gate.reason[0]).toContain("only-left is not empty")
  })

  it("refuses a name it does not serve", async () => {
    const made = held([], true)
    const found = await run(made.layer, callReplace("replace-other", {}))
    expect((found as { isError: boolean }).isError).toBe(true)
  })

  it("refuses a path it is not given", async () => {
    const made = held([], true)
    const found = await run(made.layer, callReplace("replace-survey", {}))
    expect((found as { isError: boolean }).isError).toBe(true)
  })
})
