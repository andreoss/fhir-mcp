import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { SCHEMA_VERSION, open } from "./store.js"
import type { Store } from "./store.js"
import type { FhirResource } from "../core/engine.js"

const patient = (id: string, family: string, birthDate?: string): FhirResource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Homer"] }],
  ...(birthDate === undefined ? {} : { birthDate })
})

const withStore = <A>(use: (store: Store) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(open(":memory:"), (store) => Effect.promise(() => use(store)))
    )
  )

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

describe("store", () => {
  it("records the schema version it applied", () =>
    withStore(async (store) => {
      expect(await run(store.schemaVersion())).toBe(SCHEMA_VERSION)
    }))

  it("applies the schema once and stays at that version", () =>
    withStore(async (store) => {
      await run(store.migrate())
      await run(store.migrate())
      expect(await run(store.schemaVersion())).toBe(SCHEMA_VERSION)
    }))

  it("writes a resource and reads it back", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson", "1956-05-12")))
      const found = await run(store.read("Patient", "p1"))
      expect(found.resourceType).toBe("Patient")
      expect(found.id).toBe("p1")
      expect(found["meta"]).toMatchObject({ versionId: "1" })
    }))

  it("reports a resource that was never written as not found", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.read("Patient", "absent")))).toBe("NotFound")
    }))

  it("gives a new version on update and keeps the old one", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.put(patient("p1", "Flanders")))
      const current = await run(store.read("Patient", "p1"))
      expect((current["meta"] as { versionId: string }).versionId).toBe("2")
      expect(await run(store.versions("Patient", "p1"))).toBe(2)
    }))

  it("reports a deleted resource as gone, not as missing", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.remove("Patient", "p1"))
      expect(tag(await exit(store.read("Patient", "p1")))).toBe("Gone")
    }))

  it("keeps a deleted resource out of every search result", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.put(patient("p2", "Simpson")))
      await run(store.remove("Patient", "p1"))
      const bundle = await run(store.search({ type: "Patient", parameters: [["family", "Simpson"]] }))
      expect(bundle.total).toBe(1)
      expect(bundle.entry?.[0]?.resource.id).toBe("p2")
    }))

  it("searches by a declared parameter", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.put(patient("p2", "Flanders")))
      const bundle = await run(store.search({ type: "Patient", parameters: [["family", "Simpson"]] }))
      expect(bundle.total).toBe(1)
      expect(bundle.entry?.[0]?.resource.id).toBe("p1")
    }))

  it("treats two parameters as both having to match", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson", "1956-05-12")))
      await run(store.put(patient("p2", "Simpson", "1980-01-01")))
      const bundle = await run(store.search({
        type: "Patient",
        parameters: [["family", "Simpson"], ["birthdate", "1956-05-12"]]
      }))
      expect(bundle.total).toBe(1)
      expect(bundle.entry?.[0]?.resource.id).toBe("p1")
    }))

  it("searches a repeating element by any of its values", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      const bundle = await run(store.search({ type: "Patient", parameters: [["given", "Homer"]] }))
      expect(bundle.total).toBe(1)
    }))

  it("finds by logical id", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.put(patient("p2", "Simpson")))
      const bundle = await run(store.search({ type: "Patient", parameters: [["_id", "p2"]] }))
      expect(bundle.total).toBe(1)
      expect(bundle.entry?.[0]?.resource.id).toBe("p2")
    }))

  it("returns every resource of a type when nothing is asked of it", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.put(patient("p2", "Flanders")))
      expect((await run(store.search({ type: "Patient", parameters: [] }))).total).toBe(2)
    }))

  it("refuses a parameter it does not index rather than scanning", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.search({ type: "Patient", parameters: [["colour", "blue"]] })))).toBe("Rejected")
    }))

  it("refuses a resource type it does not serve", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.search({ type: "Sasquatch", parameters: [] })))).toBe("Rejected")
    }))

  it("refuses a body whose type does not match where it is being put", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.put({ resourceType: "Sasquatch", id: "x" })))).toBe("Rejected")
    }))

  it("refuses a body with no id", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.put({ resourceType: "Patient" })))).toBe("Rejected")
    }))

  it("reports the types it serves and the parameters each accepts", () =>
    withStore(async (store) => {
      expect(await run(store.resourceTypes())).toContain("Patient")
      expect(await run(store.searchParameters("Patient"))).toContain("family")
      expect(await run(store.searchParameters("Patient"))).toContain("_id")
    }))

  it("does not let a value ending a quote change the query", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      const bundle = await run(store.search({
        type: "Patient",
        parameters: [["family", "' or 1=1 --"]]
      }))
      expect(bundle.total).toBe(0)
    }))

  it("removing something that was never there is refused, not silently accepted", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.remove("Patient", "never")))).toBe("NotFound")
    }))
})

describe("store, remaining paths", () => {
  it("deleting twice does not add a second delete marker", () =>
    withStore(async (store) => {
      await run(store.put(patient("p1", "Simpson")))
      await run(store.remove("Patient", "p1"))
      const after = await run(store.versions("Patient", "p1"))
      await run(store.remove("Patient", "p1"))
      expect(await run(store.versions("Patient", "p1"))).toBe(after)
    }))

  it("refuses to read a type it does not serve", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.read("Sasquatch", "x")))).toBe("Rejected")
    }))

  it("refuses to remove from a type it does not serve", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.remove("Sasquatch", "x")))).toBe("Rejected")
    }))

  it("refuses to report parameters for a type it does not serve", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.searchParameters("Sasquatch")))).toBe("Rejected")
    }))

  it("refuses an id that is not a string", () =>
    withStore(async (store) => {
      expect(tag(await exit(store.put({ resourceType: "Patient", id: "" })))).toBe("Rejected")
    }))

  it("names every unsupported parameter at once", () =>
    withStore(async (store) => {
      const failed = await exit(store.search({
        type: "Patient",
        parameters: [["colour", "blue"], ["shoe", "9"]]
      }))
      expect(tag(failed)).toBe("Rejected")
    }))

  it("keeps a version stamp the caller supplied out of the way of its own", () =>
    withStore(async (store) => {
      const written = await run(store.put({
        resourceType: "Patient",
        id: "p1",
        meta: { profile: ["http://example/p"] }
      }))
      expect((written["meta"] as { versionId: string }).versionId).toBe("1")
      expect((written["meta"] as { profile: ReadonlyArray<string> }).profile).toEqual(["http://example/p"])
    }))

  it("reports a store it cannot open as an unavailable dependency", async () => {
    const failed = await Effect.runPromiseExit(Effect.scoped(open("/does/not/exist/state.duckdb")))
    expect(tag(failed)).toBe("Unavailable")
  })
})
