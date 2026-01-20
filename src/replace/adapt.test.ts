import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as versioned from "../store/versioned.js"
import { incumbentOn, open } from "./adapt.js"
import { survey, tally } from "./survey.js"
import type { FhirResource } from "../core/engine.js"

const vance = {
  resourceType: "Patient",
  id: "p1",
  name: [{ family: "Vance", given: ["Ada"] }],
  gender: "female"
}

const seeded = async (): Promise<string> => {
  const path = join(mkdtempSync(join(tmpdir(), "adapt-")), "other.duckdb")
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(versioned.open(path), (store) =>
        store.insertVersion({
          type: "Patient",
          id: "p1",
          versionId: 1,
          lastUpdated: new Date().toISOString(),
          deleted: false,
          body: vance as unknown as FhirResource
        })
      )
    )
  )
  return path
}

describe("the incumbent this product reads of another store", () => {
  it("opens a store file it wrote and reads the resource back", async () => {
    const path = await seeded()
    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(open(path), (port) =>
          Effect.all({
            current: port.read("Patient", "p1"),
            absent: port.read("Patient", "nobody"),
            versions: port.records("Patient"),
            types: port.types()
          })
        )
      )
    )
    expect(found.current?.id).toBe("p1")
    expect(JSON.stringify(found.current?.body)).toContain("Vance")
    expect(found.absent).toBeUndefined()
    expect(found.versions).toHaveLength(1)
    expect(found.types).toEqual(["Patient"])
  })

  it("holds the schema and the search state of the store it opened", async () => {
    const path = await seeded()
    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(open(path), (port) =>
          Effect.all({ survey: survey(port), search: port.searchState() })
        )
      )
    )
    expect(found.survey.schema.version).toBe(0)
    expect(found.survey.schema.table.some((one) => one.name === "resource")).toBe(true)
    expect(tally(found.survey).versions).toBe(1)
    expect(found.search.some((one) => one.name === "family" && one.indexed > 0)).toBe(true)
  })

  it("searches by a criterion the type carries and refuses one it does not", async () => {
    const path = await seeded()
    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(open(path), (port) =>
          Effect.all({
            hit: port.matching("Patient", [["family", "Vance"]]),
            refused: Effect.exit(port.matching("Patient", [["nope", "1"]]))
          })
        )
      )
    )
    expect(found.hit.map((one) => one.id)).toEqual(["p1"])
    if (!Exit.isFailure(found.refused) || found.refused.cause._tag !== "Fail") {
      throw new Error("expected a failure")
    }
    expect(found.refused.cause.error._tag).toBe("Rejected")
  })

  it("reads a store through the connection it is handed", async () => {
    const path = await seeded()
    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(
          Effect.promise(() => DuckDBInstance.create(path).then((made) => made.connect())),
          (connection) => Effect.sync(() => connection.closeSync())
        ).pipe(
          Effect.flatMap((connection) =>
            Effect.all({
              types: incumbentOn(connection).types(),
              read: incumbentOn(connection).read("Patient", "p1")
            })
          )
        )
      )
    )
    expect(found.types).toEqual(["Patient"])
    expect(found.read?.id).toBe("p1")
  })

  it("refuses a path it cannot open as a store", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.flatMap(open(mkdtempSync(join(tmpdir(), "unopened-"))), () => Effect.void))
    )
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected a failure")
    expect(exit.cause.error._tag).toBe("Unavailable")
  })
})
