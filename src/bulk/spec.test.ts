import { describe, expect, it } from "vitest"
import { Effect, Exit, Schema } from "effect"
import {
  CHUNK,
  CONTAINER,
  ExportDoc,
  ImportDoc,
  NDJSON,
  PurgeDoc,
  ReindexDoc,
  RewriteDoc,
  chunked,
  containerOf,
  decoded,
  filtersOf,
  formatOf,
  typesOf,
  within
} from "./spec.js"

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

describe("request decoding", () => {
  it("decodes an export request", async () => {
    const ask = await run(
      decoded(ExportDoc, "export", JSON.stringify({ scope: { kind: "system" } }))
    )
    expect(ask.scope.kind).toBe("system")
  })

  it("refuses a request that is not json", async () => {
    expect(tag(await exit(decoded(ExportDoc, "export", "{")))).toBe("Rejected")
  })

  it("refuses a request the shape does not accept", async () => {
    expect(tag(await exit(decoded(ExportDoc, "export", "{}")))).toBe("Rejected")
  })

  it("decodes the scoped forms of an export", async () => {
    const patient = await run(
      decoded(
        ExportDoc,
        "export",
        JSON.stringify({ scope: { kind: "patient", ids: ["p1"] } })
      )
    )
    const group = await run(
      decoded(
        ExportDoc,
        "export",
        JSON.stringify({ scope: { kind: "group", group: "g1", ids: ["p1"] } })
      )
    )
    expect(patient.scope).toEqual({ kind: "patient", ids: ["p1"] })
    expect(group.scope).toEqual({ kind: "group", group: "g1", ids: ["p1"] })
  })

  it("decodes the other requests", async () => {
    const load = await run(
      decoded(
        ImportDoc,
        "import",
        JSON.stringify({ input: [{ type: "Patient", path: "in/p.ndjson" }] })
      )
    )
    const purge = await run(
      decoded(PurgeDoc, "bulk-delete", JSON.stringify({ type: "Patient" }))
    )
    const rewrite = await run(
      decoded(
        RewriteDoc,
        "bulk-update",
        JSON.stringify({ patch: { kind: "json", ops: [] } })
      )
    )
    const reindex = await run(decoded(ReindexDoc, "reindex", "{}"))
    expect(load.input.length).toBe(1)
    expect(purge.type).toBe("Patient")
    expect(rewrite.patch).toEqual({ kind: "json", ops: [] })
    expect(reindex.type).toBeUndefined()
  })

  it("carries a decoded value back out again", async () => {
    const held = await run(decoded(Schema.Struct({ a: Schema.Number }), "x", '{"a":1}'))
    expect(held.a).toBe(1)
  })
})

describe("export parameters", () => {
  it("defaults the output format to ndjson", async () => {
    expect(await run(formatOf(undefined))).toBe(NDJSON)
  })

  it("accepts the ndjson spellings", async () => {
    expect(await run(formatOf("application/ndjson"))).toBe("application/ndjson")
    expect(await run(formatOf("ndjson"))).toBe("ndjson")
  })

  it("refuses an output format that is not ndjson", async () => {
    expect(tag(await exit(formatOf("application/fhir+json")))).toBe("Rejected")
  })

  it("defaults the container and accepts a named one", async () => {
    expect(await run(containerOf(undefined))).toBe(CONTAINER)
    expect(await run(containerOf("vault/one"))).toBe("vault/one")
  })

  it("refuses a container that is not a name", async () => {
    expect(tag(await exit(containerOf("../escape")))).toBe("Rejected")
  })

  it("selects every served type when none is asked for", async () => {
    const all = await run(typesOf(undefined))
    expect(all).toContain("Patient")
    expect(all).toContain("Observation")
    expect(await run(typesOf([]))).toEqual(all)
  })

  it("selects the asked-for types", async () => {
    expect(await run(typesOf(["Patient"]))).toEqual(["Patient"])
  })

  it("refuses a type that is not served", async () => {
    expect(tag(await exit(typesOf(["Practitioner"])))).toBe("Rejected")
  })

  it("reads a type filter into criteria", async () => {
    const found = await run(filtersOf(["Patient?gender=male&family=Vance"]))
    expect(found).toEqual([
      { type: "Patient", criteria: [["gender", "male"], ["family", "Vance"]] }
    ])
  })

  it("unescapes a filter value", async () => {
    const found = await run(filtersOf(["Observation?subject=Patient%2Fp1"]))
    expect(found[0]?.criteria).toEqual([["subject", "Patient/p1"]])
  })

  it("reads no filter at all", async () => {
    expect(await run(filtersOf(undefined))).toEqual([])
  })

  it("refuses a filter that names no query", async () => {
    expect(tag(await exit(filtersOf(["Patient"])))).toBe("Rejected")
  })

  it("refuses a filter whose term is not a pair", async () => {
    expect(tag(await exit(filtersOf(["Patient?gender"])))).toBe("Rejected")
  })

  it("refuses a filter on a type that is not served", async () => {
    expect(tag(await exit(filtersOf(["Practitioner?name=a"])))).toBe("Rejected")
  })
})

describe("windows and chunks", () => {
  it("holds a stamp inside the window", () => {
    expect(within("2024-02-01", "2024-01-01", "2024-03-01")).toBe(true)
    expect(within("2024-02-01", undefined, undefined)).toBe(true)
  })

  it("drops a stamp before the window opens", () => {
    expect(within("2023-12-31", "2024-01-01", undefined)).toBe(false)
  })

  it("drops a stamp once the window closes", () => {
    expect(within("2024-03-01", undefined, "2024-03-01")).toBe(false)
  })

  it("cuts a list into chunks of the asked size", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it("cuts nothing into no chunk", () => {
    expect(chunked([], 2)).toEqual([])
  })

  it("falls back to the default chunk when the size is not one", () => {
    expect(chunked([1, 2], 0)).toEqual([[1, 2]])
    expect(CHUNK).toBeGreaterThan(0)
  })
})
