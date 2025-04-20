import { describe, expect, it } from "vitest"
import { Duration, Effect, Exit, Layer } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { Rules, Versions, create, defaults, read, remove } from "../core/interactions.js"
import type { Version, VersionedStore } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { apply, full } from "./bundle.js"
import type { Answer, Bundle, Entry, Grant, Result } from "./bundle.js"
import { Unit, loose, unitOn } from "./unit.js"
import type { Bound } from "./unit.js"

const instant = (n: number) => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const patient = (family: string): FhirResource => ({
  resourceType: "Patient",
  family,
  name: [{ family, given: ["Homer"] }]
})

const observation = (subject: string): FhirResource => ({
  resourceType: "Observation",
  status: "final",
  subject: { reference: subject }
})

const post = (url: string, resource: unknown, ifNoneExist?: string): Entry => ({
  resource,
  request: {
    method: "POST",
    url,
    ...(ifNoneExist === undefined ? {} : { ifNoneExist })
  }
})

const put = (url: string, resource: unknown, ifMatch?: string): Entry => ({
  resource,
  request: { method: "PUT", url, ...(ifMatch === undefined ? {} : { ifMatch }) }
})

const mend = (url: string, resource: unknown): Entry => ({
  resource,
  request: { method: "PATCH", url }
})

const drop = (url: string): Entry => ({ request: { method: "DELETE", url } })

const ask = (url: string): Entry => ({ request: { method: "GET", url } })

const named = (entry: Entry, fullUrl: string): Entry => ({ ...entry, fullUrl })

const sheaf = (type: "transaction" | "batch", entry: ReadonlyArray<Entry>): Bundle => ({
  resourceType: "Bundle",
  type,
  entry
})

const swap = (family: string) => ({
  kind: "json",
  ops: [{ op: "replace", path: "/family", value: family }]
})

const codes = (answer: Answer): ReadonlyArray<string> =>
  answer.entry.map((one) => one.response.status)

const diagnostics = (result: Result | undefined): string =>
  result?.response.outcome?.issue[0]?.diagnostics ?? ""

const fake = (delay = 0) => {
  const rows: Array<Version> = []
  let ids = 0
  let ticks = 0
  let live = 0
  let peak = 0
  const pick = (type: string, id: string) =>
    rows
      .filter((row) => row.type === type && row.id === id)
      .sort((a, b) => b.versionId - a.versionId)
  const busy = <A>(work: Effect.Effect<A>): Effect.Effect<A> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        live += 1
        peak = live > peak ? live : peak
      }),
      () => Effect.zipRight(Effect.sleep(Duration.millis(delay)), work),
      () => Effect.sync(() => {
        live -= 1
      })
    )
  const port: VersionedStore = {
    current: (type, id) => busy(Effect.sync(() => pick(type, id)[0])),
    versionAt: (type, id, versionId) =>
      Effect.succeed(pick(type, id).find((row) => row.versionId === versionId)),
    history: (type, id) => Effect.succeed(pick(type, id)),
    insertVersion: (entry) =>
      Effect.sync(() => {
        rows.push(entry)
      }),
    markDeleted: (type, id, versionId, lastUpdated) =>
      Effect.sync(() => {
        rows.push({
          type,
          id,
          versionId,
          lastUpdated,
          deleted: true,
          body: { resourceType: type, id }
        })
      }),
    purge: (type, id) =>
      Effect.sync(() => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i]
          if (row !== undefined && row.type === type && row.id === id) rows.splice(i, 1)
        }
      }),
    matching: (type, criteria) =>
      Effect.succeed(
        rows.filter(
          (row) =>
            row.type === type &&
            !row.deleted &&
            pick(row.type, row.id)[0]?.versionId === row.versionId &&
            criteria.every(
              ([name, value]) => String((row.body as Record<string, unknown>)[name]) === value
            )
        )
      ),
    mint: () =>
      Effect.sync(() => {
        ids += 1
        return `g${ids}`
      }),
    stamp: () =>
      Effect.sync(() => {
        ticks += 1
        return instant(ticks)
      })
  }
  return { port, rows, peak: () => peak }
}

const world = (delay = 0) => {
  const made = fake(delay)
  const live = Layer.mergeAll(
    Layer.succeed(Versions, made.port),
    Layer.succeed(Rules, defaults),
    Layer.succeed(Unit, loose)
  )
  return {
    rows: made.rows,
    peak: made.peak,
    run: <A, E>(effect: Effect.Effect<A, E, Versions | Rules | Unit>) =>
      Effect.runPromise(Effect.provide(effect, live)),
    exit: <A, E>(effect: Effect.Effect<A, E, Versions | Rules | Unit>) =>
      Effect.runPromiseExit(Effect.provide(effect, live))
  }
}

interface Kept {
  readonly bound: Bound
  readonly rows: (table: string) => Promise<number>
  readonly run: <A, E>(effect: Effect.Effect<A, E, Versions | Rules | Unit>) => Promise<A>
  readonly exit: <A, E>(
    effect: Effect.Effect<A, E, Versions | Rules | Unit>
  ) => Promise<Exit.Exit<A, E>>
}

const kept = async (): Promise<Kept> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const bound = await Effect.runPromise(unitOn(connection))
  const live = Layer.mergeAll(
    Layer.succeed(Versions, bound.store),
    Layer.succeed(Rules, defaults),
    Layer.succeed(Unit, bound.boundary)
  )
  const rows = async (table: string): Promise<number> => {
    const reader = await connection.runAndReadAll(`select count(*) as n from ${table}`)
    return Number(reader.getRowObjects()[0]?.["n"] ?? 0)
  }
  return {
    bound,
    rows,
    run: (effect) => Effect.runPromise(Effect.provide(effect, live)),
    exit: (effect) => Effect.runPromiseExit(Effect.provide(effect, live))
  }
}

const failed = <A, E>(result: Exit.Exit<A, E>): { readonly _tag: string } => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return result.cause.error as { readonly _tag: string }
  }
  throw new Error("expected a failure")
}

const found = (family: string) =>
  Versions.pipe(Effect.flatMap((store) => store.matching("Patient", [["family", family]])))

const reference = (result: Result | undefined): unknown => {
  const subject = result?.resource?.["subject"] as { reference?: unknown } | undefined
  return subject?.reference
}

describe("BNDL-01 transaction", () => {
  it("applies every entry of a transaction as one unit", async () => {
    const { run, rows } = await kept()
    const answer = await run(
      apply(
        sheaf("transaction", [
          post("Patient", patient("Simpson")),
          post("Patient", { ...patient("Flanders"), id: "p9" })
        ]),
        full
      )
    )
    expect(answer.type).toBe("transaction-response")
    expect(codes(answer)).toEqual(["201", "201"])
    expect(await rows("resource")).toBe(2)
    expect((await run(read("Patient", "p9")))["family"]).toBe("Flanders")
  })

  it("rolls back entries already applied when a later entry fails", async () => {
    const { run, exit, rows } = await kept()
    await run(create("Patient", patient("Simpson"), "p0"))
    const before = await rows("resource")
    const index = await rows("resource_index")
    const broken = sheaf("transaction", [
      post("Patient", patient("Bouvier")),
      put("Patient/p0", { ...patient("Flanders"), id: "p0" }),
      put("Patient/p0", { ...patient("Terwilliger"), id: "p0" }, 'W/"7"')
    ])
    expect(failed(await exit(apply(broken, full)))._tag).toBe("Conflict")
    expect(await rows("resource")).toBe(before)
    expect(await rows("resource_index")).toBe(index)
    expect((await run(read("Patient", "p0")))["family"]).toBe("Simpson")
    expect(await run(found("Bouvier"))).toEqual([])
  })

  it("leaves nothing behind when the only entry fails", async () => {
    const { exit, rows } = await kept()
    const broken = sheaf("transaction", [drop("Patient/absent")])
    expect(failed(await exit(apply(broken, full)))._tag).toBe("NotFound")
    expect(await rows("resource")).toBe(0)
    expect(await rows("resource_index")).toBe(0)
  })
})

describe("BNDL-02 batch", () => {
  it("keeps a failing entry from touching the others", async () => {
    const { run, rows } = await kept()
    const answer = await run(
      apply(
        sheaf("batch", [
          post("Patient", { ...patient("Simpson"), id: "p1" }),
          drop("Patient/absent"),
          post("Patient", { ...patient("Flanders"), id: "p2" })
        ]),
        full
      )
    )
    expect(answer.type).toBe("batch-response")
    expect(codes(answer)).toEqual(["201", "404", "201"])
    expect(await rows("resource")).toBe(2)
  })

  it("answers one result per entry in the order they were given", async () => {
    const { run } = world()
    const answer = await run(
      apply(
        sheaf("batch", [
          post("Patient", { ...patient("A"), id: "p1" }),
          post("Patient", { ...patient("B"), id: "p2" }),
          post("Patient", { ...patient("C"), id: "p3" })
        ]),
        full
      )
    )
    expect(answer.entry.map((one) => one.resource?.id)).toEqual(["p1", "p2", "p3"])
  })

  it("answers an empty bundle with no entries", async () => {
    const { run } = world()
    const answer = await run(apply({ resourceType: "Bundle", type: "batch" }, full))
    expect(answer.entry).toEqual([])
  })
})

describe("BNDL-03 entries resolve against current state", () => {
  it("creates only when conditional criteria select nothing", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const answer = await run(
      apply(
        sheaf("batch", [
          post("Patient", patient("Simpson"), "family=Simpson"),
          post("Patient", patient("Flanders"), "family=Flanders")
        ]),
        full
      )
    )
    expect(codes(answer)).toEqual(["200", "201"])
    expect(answer.entry[0]?.resource?.id).toBe("p1")
  })

  it("updates the one resource conditional criteria select", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const answer = await run(
      apply(
        sheaf("transaction", [put("Patient?family=Simpson", patient("Flanders"))]),
        full
      )
    )
    expect(codes(answer)).toEqual(["200"])
    expect((await run(read("Patient", "p1")))["family"]).toBe("Flanders")
  })

  it("deletes the one resource conditional criteria select", async () => {
    const { run, exit } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const answer = await run(
      apply(sheaf("transaction", [drop("Patient?family=Simpson")]), full)
    )
    expect(codes(answer)).toEqual(["204"])
    expect(failed(await exit(read("Patient", "p1")))._tag).toBe("Gone")
  })

  it("patches the one resource conditional criteria select", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const answer = await run(
      apply(sheaf("transaction", [mend("Patient?family=Simpson", swap("Bouvier"))]), full)
    )
    expect(codes(answer)).toEqual(["200"])
    expect((await run(read("Patient", "p1")))["family"]).toBe("Bouvier")
  })

  it("serves plain create, update, patch, delete and read entries", async () => {
    const { run } = world()
    const answer = await run(
      apply(
        sheaf("batch", [
          post("Patient", { ...patient("Simpson"), id: "p1" }),
          put("Patient/p1", { ...patient("Flanders"), id: "p1" }),
          mend("Patient/p1", swap("Bouvier")),
          ask("Patient/p1"),
          drop("Patient/p1")
        ]),
        full
      )
    )
    expect(codes(answer)).toEqual(["201", "200", "200", "200", "204"])
    expect(answer.entry[3]?.resource?.["family"]).toBe("Bouvier")
  })

  it("answers a search entry with what the store holds now", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    await run(create("Patient", patient("Simpson"), "p2"))
    await run(remove("Patient", "p2"))
    const answer = await run(apply(sheaf("batch", [ask("Patient?family=Simpson")]), full))
    const found = answer.entry[0]?.resource
    expect(found?.["resourceType"]).toBe("Bundle")
    expect(found?.["total"]).toBe(1)
    expect(codes(answer)).toEqual(["200"])
  })

  it("carries the etag and location of a write into the response", async () => {
    const { run } = world()
    const answer = await run(
      apply(sheaf("batch", [post("Patient", { ...patient("Simpson"), id: "p1" })]), full)
    )
    expect(answer.entry[0]?.response.location).toBe("Patient/p1/_history/1")
    expect(answer.entry[0]?.response.etag).toBe('W/"1"')
    expect(answer.entry[0]?.response.lastModified).toBe(instant(1))
  })

  it("honours if-match on an update entry", async () => {
    const { run } = world()
    await run(create("Patient", patient("Simpson"), "p1"))
    const answer = await run(
      apply(
        sheaf("batch", [
          put("Patient/p1", { ...patient("A"), id: "p1" }, 'W/"1"'),
          put("Patient/p1", { ...patient("B"), id: "p1" }, 'W/"1"')
        ]),
        full,
        1
      )
    )
    expect(codes(answer)).toEqual(["200", "409"])
  })

  it("resolves a reference between entries to the id that was assigned", async () => {
    const { run } = await kept()
    const answer = await run(
      apply(
        sheaf("transaction", [
          named(post("Patient", patient("Simpson")), "urn:uuid:pat"),
          post("Observation", observation("urn:uuid:pat"))
        ]),
        full
      )
    )
    const id = answer.entry[0]?.resource?.id
    expect(typeof id).toBe("string")
    expect(reference(answer.entry[1])).toBe(`Patient/${id}`)
  })

  it("resolves a reference from an entry that comes before the one it names", async () => {
    const { run } = await kept()
    const answer = await run(
      apply(
        sheaf("transaction", [
          put("Observation/o1", { ...observation("urn:uuid:pat"), id: "o1" }),
          named(post("Patient", patient("Simpson")), "urn:uuid:pat")
        ]),
        full
      )
    )
    const id = answer.entry[1]?.resource?.id
    expect(reference(answer.entry[0])).toBe(`Patient/${id}`)
  })

  it("resolves a reference to the resource a conditional create found", async () => {
    const { run } = await kept()
    await run(create("Patient", patient("Simpson"), "p1"))
    const answer = await run(
      apply(
        sheaf("transaction", [
          named(post("Patient", patient("Simpson"), "family=Simpson"), "urn:uuid:pat"),
          post("Observation", observation("urn:uuid:pat"))
        ]),
        full
      )
    )
    expect(codes(answer)).toEqual(["200", "201"])
    expect(reference(answer.entry[1])).toBe("Patient/p1")
  })

  it("resolves a reference to an id the entry supplied itself", async () => {
    const { run } = await kept()
    const answer = await run(
      apply(
        sheaf("transaction", [
          named(post("Patient", { ...patient("Simpson"), id: "p1" }), "urn:uuid:pat"),
          post("Observation", observation("urn:uuid:pat"))
        ]),
        full
      )
    )
    expect(reference(answer.entry[1])).toBe("Patient/p1")
  })

  it("keeps the full url of an entry on its result", async () => {
    const { run } = world()
    const answer = await run(
      apply(
        sheaf("batch", [named(post("Patient", { ...patient("A"), id: "p1" }), "urn:uuid:one")]),
        full
      )
    )
    expect(answer.entry[0]?.fullUrl).toBe("urn:uuid:one")
  })

  it("refuses an entry url that names no interaction", async () => {
    const { run } = world()
    const answer = await run(
      apply(
        sheaf("batch", [ask("patient/p1"), ask("Patient/p1/_history/1"), ask("")]),
        full
      )
    )
    expect(codes(answer)).toEqual(["400", "400", "400"])
  })

  it("refuses a write entry that carries no resource", async () => {
    const { run } = world()
    const answer = await run(
      apply(sheaf("batch", [post("Patient", undefined), put("Patient/p1", 4)]), full)
    )
    expect(codes(answer)).toEqual(["400", "400"])
  })

  it("refuses an entry that names neither an id nor criteria", async () => {
    const { run } = world()
    const answer = await run(
      apply(
        sheaf("batch", [
          put("Patient", patient("A")),
          drop("Patient"),
          mend("Patient", swap("B"))
        ]),
        full
      )
    )
    expect(codes(answer)).toEqual(["400", "400", "400"])
  })

  it("reads criteria that carry escaped characters", async () => {
    const { run } = world()
    await run(create("Patient", patient("van Houten"), "p1"))
    const answer = await run(
      apply(sheaf("batch", [ask("Patient?family=van%20Houten"), ask("Patient?_flag")]), full)
    )
    expect(answer.entry[0]?.resource?.["total"]).toBe(1)
    expect(answer.entry[1]?.resource?.["total"]).toBe(0)
  })
})

describe("BNDL-04 per-entry outcomes", () => {
  it("gives every entry a status and every failure an outcome", async () => {
    const { run } = world()
    const answer = await run(
      apply(
        sheaf("batch", [post("Patient", { ...patient("A"), id: "p1" }), ask("Patient/absent")]),
        full
      )
    )
    expect(answer.entry[0]?.response.outcome).toBeUndefined()
    expect(codes(answer)).toEqual(["201", "404"])
    expect(diagnostics(answer.entry[1])).toContain("Patient/absent")
  })

  it("keeps the full url of an entry on the outcome of its failure", async () => {
    const { run } = world()
    const answer = await run(
      apply(sheaf("batch", [named(ask("Patient/absent"), "urn:uuid:one")]), full)
    )
    expect(answer.entry[0]?.fullUrl).toBe("urn:uuid:one")
    expect(codes(answer)).toEqual(["404"])
  })

  it("refuses a named entry whose url names no interaction", async () => {
    const { exit } = world()
    const broken = sheaf("transaction", [
      named(post("patient", patient("A")), "urn:uuid:one")
    ])
    expect(failed(await exit(apply(broken, full)))._tag).toBe("Rejected")
  })

  it("fails only the unauthorized entry of a batch", async () => {
    const { run, rows } = world()
    const grant: Grant = { read: true, write: false, types: [] }
    await run(create("Patient", patient("Simpson"), "p1"))
    const before = rows.length
    const answer = await run(
      apply(sheaf("batch", [post("Patient", patient("A")), ask("Patient/p1")]), grant)
    )
    expect(codes(answer)).toEqual(["403", "200"])
    expect(diagnostics(answer.entry[0])).toContain("POST Patient")
    expect(rows.length).toBe(before)
  })

  it("fails the whole transaction on an unauthorized entry", async () => {
    const { exit, rows } = await kept()
    const grant: Grant = { read: true, write: false, types: [] }
    const broken = sheaf("transaction", [
      post("Patient", { ...patient("A"), id: "p1" }),
      post("Patient", { ...patient("B"), id: "p2" })
    ])
    expect(failed(await exit(apply(broken, grant)))._tag).toBe("Forbidden")
    expect(await rows("resource")).toBe(0)
  })

  it("refuses a type the grant does not name", async () => {
    const { run } = world()
    const grant: Grant = { read: true, write: true, types: ["Patient"] }
    const answer = await run(
      apply(
        sheaf("batch", [
          post("Patient", { ...patient("A"), id: "p1" }),
          post("Observation", observation("Patient/p1"))
        ]),
        grant
      )
    )
    expect(codes(answer)).toEqual(["201", "403"])
  })

  it("refuses a read entry when the grant does not carry read", async () => {
    const { run } = world()
    const grant: Grant = { read: false, write: true, types: [] }
    const answer = await run(apply(sheaf("batch", [ask("Patient/p1")]), grant))
    expect(codes(answer)).toEqual(["403"])
  })
})

describe("BNDL-05 entry orchestration", () => {
  it("never runs more batch entries at once than the bound allows", async () => {
    const { run, peak } = world(5)
    const entries = Array.from({ length: 16 }, (_, n) =>
      post("Patient", { ...patient("A"), id: `p${n}` })
    )
    const answer = await run(apply(sheaf("batch", entries), full, 3))
    expect(answer.entry.length).toBe(16)
    expect(peak()).toBeLessThanOrEqual(3)
    expect(peak()).toBeGreaterThan(1)
  })

  it("never runs more batch entries at once than the store has lanes", async () => {
    const made = fake(5)
    const live = Layer.mergeAll(
      Layer.succeed(Versions, made.port),
      Layer.succeed(Rules, defaults),
      Layer.succeed(Unit, { lanes: 1, within: loose.within })
    )
    const entries = Array.from({ length: 6 }, (_, n) =>
      post("Patient", { ...patient("A"), id: `p${n}` })
    )
    await Effect.runPromise(Effect.provide(apply(sheaf("batch", entries), full, 6), live))
    expect(made.peak()).toBe(1)
  })

  it("runs a transaction one entry at a time", async () => {
    const { run, peak } = world(2)
    const entries = Array.from({ length: 8 }, (_, n) =>
      post("Patient", { ...patient("A"), id: `p${n}` })
    )
    await run(apply(sheaf("transaction", entries), full, 4))
    expect(peak()).toBe(1)
  })

  it("refuses a bound that is not a bound", async () => {
    const { exit } = world()
    expect(failed(await exit(apply(sheaf("batch", []), full, 0)))._tag).toBe("Rejected")
    expect(failed(await exit(apply(sheaf("batch", []), full, 1.5)))._tag).toBe("Rejected")
  })
})
