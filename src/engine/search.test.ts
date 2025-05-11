import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { grant } from "../auth/scope.js"
import { manager } from "../compartment/definition.js"
import type { Scoped } from "../compartment/search.js"
import { FhirEngine } from "../core/engine.js"
import type { Bundle, FhirResource } from "../core/engine.js"
import { key } from "../params/model.js"
import type { Definition, Entry, Snapshot, Status } from "../params/model.js"
import { ensure, index } from "../store/query.js"
import type { Frag, IndexEntry } from "../store/query.js"
import { cache } from "./cache.js"
import type { Cache, Held } from "./cache.js"
import { UNRESTRICTED, granted } from "./restriction.js"
import type { Restriction } from "./restriction.js"
import { bound, engine } from "./search.js"
import type { Deps } from "./search.js"

const BASE: ReadonlyArray<string> = [
  `create sequence if not exists surrogate_id start 1`,
  `create table if not exists resource (
     surrogate_id bigint primary key,
     resource_type varchar not null,
     logical_id varchar not null,
     version_id integer not null,
     last_updated timestamp not null,
     deleted boolean not null,
     is_current boolean not null,
     body varchar not null
   )`,
  `create table if not exists resource_index (
     surrogate_id bigint not null,
     resource_type varchar not null,
     name varchar not null,
     value varchar not null
   )`
]

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const rows = async (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const reader = await connection.runAndReadAll(sql, [...values] as never)
  return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
}

interface Db {
  readonly connection: DuckDBConnection
  readonly put: (
    resource: FhirResource,
    list: ReadonlyArray<IndexEntry>
  ) => Promise<void>
}

const database = async (): Promise<Db> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  for (const statement of BASE) await connection.run(statement)
  await run(ensure(connection))
  const put = async (resource: FhirResource, list: ReadonlyArray<IndexEntry>) => {
    const found = await rows(
      connection,
      `insert into resource
         (surrogate_id, resource_type, logical_id, version_id,
          last_updated, deleted, is_current, body)
       values (nextval('surrogate_id'), ?, ?, 1,
               cast('2024-01-01 00:00:00' as timestamp), false, true, ?)
       returning surrogate_id`,
      [resource.resourceType, String(resource.id), JSON.stringify(resource)]
    )
    const surrogate = BigInt(String(found[0]?.["surrogate_id"]))
    await run(index(connection, surrogate, resource.resourceType, list))
  }
  return { connection, put }
}

const token = (name: string, code: string): IndexEntry => ({
  kind: "token",
  name,
  system: undefined,
  code,
  text: code
})

const points = (name: string, type: string, id: string): IndexEntry => ({
  kind: "reference",
  name,
  targetType: type,
  targetId: id,
  url: undefined,
  idSystem: undefined,
  idCode: undefined
})

const moment = (name: string, at: string): IndexEntry => ({
  kind: "date",
  name,
  low: at,
  high: at
})

const patient = (id: string, family: string) => ({
  resourceType: "Patient",
  id,
  name: [{ family }]
})

const encounter = (id: string, status: string, of: string) => ({
  resourceType: "Encounter",
  id,
  status,
  subject: { reference: `Patient/${of}` }
})

const observation = (
  id: string,
  of: string,
  meeting: string,
  status: string,
  at: string
) => ({
  resourceType: "Observation",
  id,
  status,
  code: { coding: [{ code: "vital" }] },
  subject: { reference: `Patient/${of}` },
  encounter: { reference: `Encounter/${meeting}` },
  effectiveDateTime: at
})

const seeded = async (db: Db): Promise<void> => {
  await db.put(patient("p1", "Simpson"), [])
  await db.put(patient("p2", "Flanders"), [])
  for (const [id, status, of] of [
    ["e1", "finished", "p1"],
    ["e2", "planned", "p1"],
    ["e3", "finished", "p2"]
  ] as const) {
    await db.put(encounter(id, status, of), [
      token("status", status),
      points("subject", "Patient", of)
    ])
  }
  for (const [id, of, meeting, status, at] of [
    ["o1", "p1", "e1", "final", "2024-03-15"],
    ["o2", "p2", "e3", "final", "2024-03-15"],
    ["o3", "p1", "e1", "preliminary", "2024-03-15"],
    ["o4", "p1", "e1", "final", "2020-01-01"],
    ["o5", "p1", "e2", "final", "2024-03-15"]
  ] as const) {
    await db.put(observation(id, of, meeting, status, at), [
      token("status", status),
      token("code", "vital"),
      points("subject", "Patient", of),
      points("encounter", "Encounter", meeting),
      moment("date", `${at}T00:00:00.000Z`)
    ])
  }
}

const shape = (
  type: string,
  name: string,
  valueType: Definition["valueType"],
  targets: ReadonlyArray<string> = []
): Definition => ({ type, name, valueType, path: [name], targets, components: [] })

const one = (definition: Definition, status: Status): Entry => ({
  definition,
  status,
  version: 1,
  done: 0,
  total: 0,
  failures: 0,
  updatedAt: "1970-01-01T00:00:00.000Z"
})

const SNAPSHOT: Snapshot = {
  epoch: 7,
  entries: new Map(
    [
      one(shape("Patient", "_id", "token"), "active"),
      one(shape("Patient", "family", "string"), "active"),
      one(shape("Observation", "_id", "token"), "active"),
      one(shape("Observation", "code", "token"), "active"),
      one(shape("Observation", "status", "token"), "active"),
      one(shape("Observation", "date", "date"), "active"),
      one(shape("Observation", "subject", "reference", ["Patient"]), "active"),
      one(shape("Observation", "encounter", "reference", ["Encounter"]), "active"),
      one(shape("Observation", "identifier", "token"), "backfilling"),
      one(shape("Encounter", "_id", "token"), "active"),
      one(shape("Encounter", "status", "token"), "active"),
      one(shape("Encounter", "subject", "reference", ["Patient"]), "active")
    ].map((entry) => [key(entry), entry] as const)
  )
}

const depsOf = async (db: Db, held: Cache): Promise<Deps> => ({
  connection: db.connection,
  manager: await run(manager()),
  snapshot: Effect.succeed(SNAPSHOT),
  cache: held
})

const made = async (db: Db, restriction: Restriction, held: Cache) =>
  engine(await depsOf(db, held), restriction)

const withDb = async (use: (db: Db) => Promise<void>): Promise<void> => {
  const db = await database()
  try {
    await seeded(db)
    await use(db)
  } finally {
    db.connection.closeSync()
  }
}

type Entries = ReadonlyArray<readonly [string, string]>

const ids = (bundle: Bundle): ReadonlyArray<string> =>
  (bundle.entry ?? []).map((entry) => String(entry.resource.id))

const found = async (
  db: Db,
  restriction: Restriction,
  parameters: Entries,
  type = "Observation"
): Promise<Bundle> => {
  const held = await made(db, restriction, await run(cache()))
  return run(held.search({ type, parameters }))
}

const tally = async (db: Db, frag: Frag): Promise<number> => {
  const counted = await rows(
    db.connection,
    `select count(*) as n from (${frag.sql}) q`,
    frag.values
  )
  return Number(counted[0]?.["n"] ?? -1)
}

const p1 = granted(grant(["patient:p1/*.read"]))
const p2 = granted(grant(["patient:p2/*.read"]))
const anyone = granted(grant(["system/*.read"]))
const forged = { name: "unrestricted", grant: undefined } as unknown as Restriction

const ASK: Entries = [
  ["status:not", "preliminary"],
  ["encounter.status", "finished"],
  ["date", "ge2024-01-01"],
  ["date", "le2024-12-31"]
]

const reason = async <A, E>(effect: Effect.Effect<A, E>): Promise<string> => {
  const result = await exit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    const failure = result.cause.error as {
      readonly _tag: string
      readonly reason?: string
      readonly action?: string
    }
    return `${failure._tag}: ${failure.reason ?? failure.action ?? ""}`
  }
  throw new Error("expected a refusal")
}

describe("a modifier, a chain and a date range through one pipeline", () => {
  it("answers with the resources every stage admits", () =>
    withDb(async (db) => {
      expect(ids(await found(db, UNRESTRICTED, ASK))).toEqual(["o1", "o2"])
    }))

  it("counts what it returns", () =>
    withDb(async (db) => {
      expect((await found(db, UNRESTRICTED, ASK)).total).toBe(2)
    }))

  it("admits what the modifier alone was refusing", () =>
    withDb(async (db) => {
      const without = ASK.filter(([name]) => name !== "status:not")
      expect(ids(await found(db, UNRESTRICTED, without))).toContain("o3")
    }))

  it("admits what the date range alone was refusing", () =>
    withDb(async (db) => {
      const without = ASK.filter(([name]) => name !== "date")
      expect(ids(await found(db, UNRESTRICTED, without))).toContain("o4")
    }))

  it("admits what the chain alone was refusing", () =>
    withDb(async (db) => {
      const without = ASK.filter(([name]) => name !== "encounter.status")
      expect(ids(await found(db, UNRESTRICTED, without))).toContain("o5")
    }))

  it("carries the whole resource back in the bundle", () =>
    withDb(async (db) => {
      const bundle = await found(db, UNRESTRICTED, ASK)
      expect(bundle.resourceType).toBe("Bundle")
      expect(bundle.type).toBe("searchset")
      expect(bundle.entry?.[0]?.fullUrl).toBe("Observation/o1")
      expect(bundle.entry?.[0]?.resource["effectiveDateTime"]).toBe("2024-03-15")
    }))
})

describe("a grant restricts the answer, and the query carries it", () => {
  const CODE: Entries = [["code", "vital"]]

  it("answers everything when the grant names no compartment", () =>
    withDb(async (db) => {
      expect(ids(await found(db, anyone, CODE)))
        .toEqual(["o1", "o2", "o3", "o4", "o5"])
    }))

  it("answers only the compartment the grant names", () =>
    withDb(async (db) => {
      expect(ids(await found(db, p1, CODE))).toEqual(["o1", "o3", "o4", "o5"])
      expect(ids(await found(db, p2, CODE))).toEqual(["o2"])
    }))

  it("restricts a chained search on both ends", () =>
    withDb(async (db) => {
      expect(ids(await found(db, p1, ASK))).toEqual(["o1"])
      expect(ids(await found(db, p2, ASK))).toEqual(["o2"])
    }))

  it("puts the restriction in the emitted query, not after it", () =>
    withDb(async (db) => {
      const held = await made(db, p1, await run(cache()))
      const plan: Scoped = await run(
        held.prepare({ type: "Observation", parameters: CODE })
      )
      expect(plan.count.sql).toContain("index_reference")
      expect(plan.count.sql).toContain("target_id = ?")
      expect(plan.count.values).toContain("p1")
      expect(plan.page.values).toContain("p1")
    }))

  it("emits no such predicate when nothing restricts it", () =>
    withDb(async (db) => {
      const held = await made(db, UNRESTRICTED, await run(cache()))
      const plan = await run(held.prepare({ type: "Observation", parameters: CODE }))
      expect(plan.count.values).not.toContain("p1")
      expect(plan.count.sql).not.toContain("index_reference")
    }))

  it("agrees with the count the database makes of the same query", () =>
    withDb(async (db) => {
      const held = await made(db, p2, await run(cache()))
      const plan = await run(held.prepare({ type: "Observation", parameters: CODE }))
      const bundle = await run(held.search({ type: "Observation", parameters: CODE }))
      expect(await tally(db, plan.page)).toBe(1)
      expect(await tally(db, plan.count)).toBe(1)
      expect(bundle.total).toBe(1)
      expect(ids(bundle)).toEqual(["o2"])
    }))

  it("refuses a type the grant does not reach", () =>
    withDb(async (db) => {
      const only = granted(grant(["user/Patient.read"]))
      const said = await reason(
        (await made(db, only, await run(cache()))).search({
          type: "Observation",
          parameters: []
        })
      )
      expect(said).toContain("Forbidden")
    }))

  it("pages inside the restriction", () =>
    withDb(async (db) => {
      const held = await made(db, p1, await run(cache()))
      const bundle = await run(
        held.search({
          type: "Observation",
          parameters: [["code", "vital"]],
          offset: 1,
          limit: 2
        })
      )
      expect(ids(bundle)).toEqual(["o3", "o4"])
      expect(bundle.total).toBe(4)
    }))
})

describe("a parameter that is not ready is refused, not answered", () => {
  it("refuses it and says why", () =>
    withDb(async (db) => {
      const said = await reason(
        (await made(db, UNRESTRICTED, await run(cache()))).search({
          type: "Observation",
          parameters: [["identifier", "abc"]]
        })
      )
      expect(said).toContain("Rejected")
      expect(said).toContain("not ready")
    }))

  it("refuses it before the grant is even consulted", () =>
    withDb(async (db) => {
      const only = granted(grant(["user/Patient.read"]))
      const said = await reason(
        (await made(db, only, await run(cache()))).search({
          type: "Observation",
          parameters: [["identifier", "abc"]]
        })
      )
      expect(said).toContain("not ready")
      expect(said).not.toContain("Forbidden")
    }))

  it("refuses a parameter no registry declares", () =>
    withDb(async (db) => {
      const said = await reason(
        (await made(db, UNRESTRICTED, await run(cache()))).search({
          type: "Observation",
          parameters: [["shoesize", "9"]]
        })
      )
      expect(said).toContain("unknown search parameter")
    }))

  it("holds nothing in the cache for a refused search", () =>
    withDb(async (db) => {
      const held = await run(cache())
      await exit(
        (await made(db, UNRESTRICTED, held)).search({
          type: "Observation",
          parameters: [["identifier", "abc"]]
        })
      )
      expect((await run(held.state)).keys).toEqual([])
    }))
})

describe("no search without a grant, and none by omission", () => {
  it("answers when the unrestricted path is named", () =>
    withDb(async (db) => {
      expect(ids(await found(db, UNRESTRICTED, [["code", "vital"]]))).toHaveLength(5)
    }))

  it("refuses a restriction that was never issued", () =>
    withDb(async (db) => {
      const said = await reason(
        (await made(db, forged, await run(cache()))).search({
          type: "Observation",
          parameters: [["code", "vital"]]
        })
      )
      expect(said).toContain("Forbidden")
    }))

  it("refuses a read the same way", () =>
    withDb(async (db) => {
      const said = await reason(
        (await made(db, forged, await run(cache()))).read("Observation", "o1")
      )
      expect(said).toContain("Forbidden")
    }))

  it("names the unrestricted path in the cache key it uses", () =>
    withDb(async (db) => {
      const held = await run(cache())
      await run(
        (await made(db, UNRESTRICTED, held)).search({
          type: "Observation",
          parameters: [["code", "vital"]]
        })
      )
      expect((await run(held.state)).keys[0]).toContain("unrestricted")
    }))
})

describe("two grants never share a cache entry", () => {
  it("keeps one entry per grant for the same request", () =>
    withDb(async (db) => {
      const held = await run(cache())
      const ask = { type: "Observation", parameters: [["code", "vital"]] as Entries }
      const first = await run((await made(db, p1, held)).search(ask))
      const second = await run((await made(db, p2, held)).search(ask))
      expect(ids(first)).toEqual(["o1", "o3", "o4", "o5"])
      expect(ids(second)).toEqual(["o2"])
      const state = await run(held.state)
      expect(state.keys).toHaveLength(2)
      expect(state.keys[0]).not.toBe(state.keys[1])
      expect(state.hits).toBe(0)
      expect(state.misses).toBe(2)
    }))

  it("does not answer one grant from the other one's entry", () =>
    withDb(async (db) => {
      const held = await run(cache())
      const ask = { type: "Observation", parameters: [["code", "vital"]] as Entries }
      await run((await made(db, p1, held)).search(ask))
      expect(ids(await run((await made(db, p2, held)).search(ask)))).toEqual(["o2"])
      expect(ids(await run((await made(db, p1, held)).search(ask))))
        .toEqual(["o1", "o3", "o4", "o5"])
      expect((await run(held.state)).hits).toBe(1)
    }))

  it("separates the unrestricted path from a grant", () =>
    withDb(async (db) => {
      const held = await run(cache())
      const ask = { type: "Observation", parameters: [["code", "vital"]] as Entries }
      await run((await made(db, UNRESTRICTED, held)).search(ask))
      expect(ids(await run((await made(db, p1, held)).search(ask))))
        .toEqual(["o1", "o3", "o4", "o5"])
      expect((await run(held.state)).keys).toHaveLength(2)
    }))

  it("separates one page of a request from another", () =>
    withDb(async (db) => {
      const held = await run(cache())
      const engineOne = await made(db, p1, held)
      await run(engineOne.search({ type: "Observation", parameters: [], limit: 2 }))
      await run(
        engineOne.search({ type: "Observation", parameters: [], limit: 2, offset: 2 })
      )
      expect((await run(held.state)).keys).toHaveLength(2)
    }))
})

describe("a prepared plan is reused", () => {
  const spy = (
    inner: Cache,
    log: { taken: Held | undefined; kept: Scoped | undefined }
  ): Cache => ({
    take: (at) =>
      Effect.map(inner.take(at), (entry) => {
        log.taken = entry
        return entry
      }),
    keep: (at, plan) =>
      Effect.map(inner.keep(at, plan), () => {
        log.kept = plan
      }),
    demote: inner.demote,
    state: inner.state
  })

  it("runs the second identical search from the plan the first built", () =>
    withDb(async (db) => {
      const inner = await run(cache())
      const log = {
        taken: undefined as Held | undefined,
        kept: undefined as Scoped | undefined
      }
      const held = await made(db, p1, spy(inner, log))
      const ask = { type: "Observation", parameters: [["code", "vital"]] as Entries }
      await run(held.search(ask))
      const before = log.kept
      const second = await run(held.search(ask))
      expect(log.taken?.plan).toBe(before)
      expect(ids(second)).toEqual(["o1", "o3", "o4", "o5"])
      expect((await run(inner.state)).hits).toBe(1)
    }))
})

describe("a regression disables the cache rather than answering wrongly", () => {
  const bent = (inner: Cache, spoil: (at: string, held: Held) => Held): Cache => ({
    take: (at) =>
      Effect.map(inner.take(at), (entry) =>
        entry === undefined ? undefined : spoil(at, entry)
      ),
    keep: inner.keep,
    demote: inner.demote,
    state: inner.state
  })

  const ask = { type: "Observation", parameters: [["code", "vital"]] as Entries }

  it("refuses a plan kept under another key and answers correctly", () =>
    withDb(async (db) => {
      const inner = await run(cache())
      const held = await made(
        db,
        p1,
        bent(inner, (_, entry) => ({ key: "elsewhere", plan: entry.plan }))
      )
      await run(held.search(ask))
      const second = await run(held.search(ask))
      expect(ids(second)).toEqual(["o1", "o3", "o4", "o5"])
      const state = await run(inner.state)
      expect(state.enabled).toBe(false)
      expect(state.reason).toContain("key")
    }))

  it("drops a plan that no longer runs and answers correctly", () =>
    withDb(async (db) => {
      const inner = await run(cache())
      const held = await made(
        db,
        p1,
        bent(inner, (at, entry) => ({
          key: at,
          plan: { ...entry.plan, page: { sql: "select body from nowhere", values: [] } }
        }))
      )
      await run(held.search(ask))
      const second = await run(held.search(ask))
      expect(ids(second)).toEqual(["o1", "o3", "o4", "o5"])
      const state = await run(inner.state)
      expect(state.enabled).toBe(false)
      expect(state.reason).toContain("failed")
    }))

  it("keeps answering with the cache off", () =>
    withDb(async (db) => {
      const inner = await run(cache())
      await run(inner.demote("off"))
      const held = await made(db, p1, inner)
      expect(ids(await run(held.search(ask)))).toEqual(["o1", "o3", "o4", "o5"])
      expect((await run(inner.state)).keys).toEqual([])
    }))
})

describe("the rest of the port stays inside the restriction", () => {
  it("reads a resource the grant reaches", () =>
    withDb(async (db) => {
      const held = await made(db, p1, await run(cache()))
      expect(String((await run(held.read("Observation", "o1"))).id)).toBe("o1")
    }))

  it("does not read a resource outside the grant", () =>
    withDb(async (db) => {
      const held = await made(db, p2, await run(cache()))
      const said = await reason(held.read("Observation", "o1"))
      expect(said).toContain("NotFound")
    }))

  it("does not read a resource that is not there", () =>
    withDb(async (db) => {
      const held = await made(db, UNRESTRICTED, await run(cache()))
      expect(await reason(held.read("Observation", "o9"))).toContain("NotFound")
    }))

  it("lists only the types the grant reaches", () =>
    withDb(async (db) => {
      const only = granted(grant(["user/Patient.read"]))
      expect(await run((await made(db, only, await run(cache()))).resourceTypes()))
        .toEqual(["Patient"])
      const all = await made(db, UNRESTRICTED, await run(cache()))
      expect(await run(all.resourceTypes()))
        .toContain("Observation")
    }))

  it("lists only the parameters that are ready", () =>
    withDb(async (db) => {
      const held = await made(db, UNRESTRICTED, await run(cache()))
      const names = await run(held.searchParameters("Observation"))
      expect([...names].sort()).toEqual([
        "_id",
        "code",
        "date",
        "encounter",
        "status",
        "subject"
      ])
    }))

  it("refuses the parameters of a type the grant does not reach", () =>
    withDb(async (db) => {
      const only = granted(grant(["user/Patient.read"]))
      const held = await made(db, only, await run(cache()))
      expect(await reason(held.searchParameters("Observation"))).toContain("Forbidden")
    }))

  it("refuses the parameters of a type nothing serves", () =>
    withDb(async (db) => {
      const held = await made(db, UNRESTRICTED, await run(cache()))
      expect(await reason(held.searchParameters("Sundial"))).toContain("Rejected")
    }))
})

describe("the port the surface binds", () => {
  it("answers through the tag the surface asks for", () =>
    withDb(async (db) => {
      const layer = bound(await depsOf(db, await run(cache())), UNRESTRICTED)
      const bundle = await run(
        Effect.provide(
          Effect.flatMap(FhirEngine, (held) =>
            held.search({ type: "Observation", parameters: [["code", "vital"]] })
          ),
          layer
        )
      )
      expect(ids(bundle)).toHaveLength(5)
    }))
})

describe("an include is carried, restricted, and never cached", () => {
  const ask: Entries = [
    ["_id", "o1"],
    ["_include", "Observation:subject"]
  ]

  it("carries the resource the include reaches", () =>
    withDb(async (db) => {
      const held = await run(cache())
      const bundle = await run((await made(db, p1, held)).search({
        type: "Observation",
        parameters: ask
      }))
      expect(ids(bundle)).toEqual(["o1", "p1"])
      expect((await run(held.state)).keys).toEqual([])
    }))

  it("carries nothing the grant does not reach", () =>
    withDb(async (db) => {
      const bundle = await found(db, p2, ask)
      expect(ids(bundle)).toEqual([])
    }))
})
