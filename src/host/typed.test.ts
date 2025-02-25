import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import type { Version } from "../core/interactions.js"
import { versionedOn } from "../store/versioned.js"
import { ensure } from "../store/query.js"
import { entriesOf, typed } from "./typed.js"

const observation: FhirResource = {
  resourceType: "Observation",
  id: "o1",
  status: "final",
  code: { coding: [{ code: "8867-4" }] },
  subject: { reference: "Patient/p1" }
}

const version = (body: FhirResource): Version => ({
  type: body.resourceType,
  id: String(body.id),
  versionId: 1,
  lastUpdated: new Date().toISOString(),
  deleted: false,
  body
})

const opened = async (): Promise<DuckDBConnection> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  await Effect.runPromise(ensure(connection))
  return connection
}

const counted = async (connection: DuckDBConnection, table: string): Promise<number> => {
  const reader = await connection.runAndReadAll(`select count(*) as n from ${table}`)
  return Number(reader.getRowObjects()[0]?.["n"] ?? 0)
}

const wrapped = async (connection: DuckDBConnection) =>
  typed(connection, await Effect.runPromise(versionedOn(connection)))

describe("what a write puts in the typed index", () => {
  it("names the typed entries a resource carries", () => {
    const kinds = entriesOf("Observation", observation).map((one) => one.kind).sort()
    expect(kinds).toContain("token")
    expect(kinds).toContain("reference")
  })

  it("holds nothing for a type it does not define", () => {
    expect(entriesOf("Practitioner", { resourceType: "Practitioner", id: "x" })).toEqual([])
  })

  it("writes the typed rows a modifier and a chain need", async () => {
    const connection = await opened()
    const store = await wrapped(connection)
    await Effect.runPromise(store.insertVersion(version(observation)))
    expect(await counted(connection, "index_token")).toBeGreaterThan(0)
    expect(await counted(connection, "index_reference")).toBe(1)
    connection.closeSync()
  })

  it("writes no typed row for a version that records a deletion", async () => {
    const connection = await opened()
    const store = await wrapped(connection)
    await Effect.runPromise(
      store.insertVersion({ ...version(observation), deleted: true })
    )
    expect(await counted(connection, "index_reference")).toBe(0)
    connection.closeSync()
  })

  it("takes the typed rows away when the record is purged", async () => {
    const connection = await opened()
    const store = await wrapped(connection)
    await Effect.runPromise(store.insertVersion(version(observation)))
    await Effect.runPromise(store.purge("Observation", "o1"))
    expect(await counted(connection, "index_reference")).toBe(0)
    connection.closeSync()
  })

  it("reports a store it cannot write to rather than losing the index", async () => {
    const connection = await opened()
    const store = await wrapped(connection)
    connection.closeSync()
    const exit = await Effect.runPromiseExit(store.insertVersion(version(observation)))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
