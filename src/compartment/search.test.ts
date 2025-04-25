import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { parse } from "../search/parse.js"
import { ensure, index } from "../store/query.js"
import type { Frag, IndexEntry } from "../store/query.js"
import { PATIENT, manager } from "./definition.js"
import type { Definition } from "./definition.js"
import type { Limit } from "./filter.js"
import { plans, scoped, within } from "./search.js"

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
  readonly put: (type: string, id: string) => Promise<bigint>
  readonly entries: (
    surrogate: bigint,
    type: string,
    list: ReadonlyArray<IndexEntry>
  ) => Promise<void>
}

const database = async (): Promise<Db> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  for (const statement of BASE) await connection.run(statement)
  await run(ensure(connection))
  const put = async (type: string, id: string) => {
    const found = await rows(
      connection,
      `insert into resource
         (surrogate_id, resource_type, logical_id, version_id,
          last_updated, deleted, is_current, body)
       values (nextval('surrogate_id'), ?, ?, 1,
               cast('2024-01-01 00:00:00' as timestamp), false, true, ?)
       returning surrogate_id`,
      [type, id, JSON.stringify({ resourceType: type, id })]
    )
    return BigInt(String(found[0]?.["surrogate_id"]))
  }
  const entries = (surrogate: bigint, type: string, list: ReadonlyArray<IndexEntry>) =>
    run(index(connection, surrogate, type, list))
  return { connection, put, entries }
}

const token = (name: string, code: string): IndexEntry => ({
  kind: "token",
  name,
  system: undefined,
  code,
  text: undefined
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

const seeded = async (db: Db): Promise<void> => {
  await db.put("Patient", "p1")
  await db.put("Patient", "p2")
  const e1 = await db.put("Encounter", "e1")
  await db.entries(e1, "Encounter", [
    points("subject", "Patient", "p1"),
    token("status", "planned")
  ])
  const e2 = await db.put("Encounter", "e2")
  await db.entries(e2, "Encounter", [
    points("subject", "Patient", "p2"),
    token("status", "finished")
  ])
  const o1 = await db.put("Observation", "o1")
  await db.entries(o1, "Observation", [
    points("subject", "Patient", "p1"),
    points("encounter", "Encounter", "e1"),
    points("encounter", "Encounter", "e2"),
    token("code", "vital")
  ])
  const o2 = await db.put("Observation", "o2")
  await db.entries(o2, "Observation", [
    points("subject", "Patient", "p2"),
    token("code", "vital")
  ])
}

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

const result = (db: Db, type: string, entries: Entries, limits: ReadonlyArray<Limit>) =>
  run(Effect.flatMap(parse(type, entries), (query) => scoped(db.connection, query, limits)))

const built = (type: string, entries: Entries, limits: ReadonlyArray<Limit>) =>
  run(Effect.flatMap(parse(type, entries), (query) => plans(query, limits)))

const matched = async (
  db: Db,
  type: string,
  entries: Entries,
  limits: ReadonlyArray<Limit>
): Promise<ReadonlyArray<string>> => {
  const found = await result(db, type, entries, limits)
  return found.entry
    .filter((one) => one.mode === "match")
    .map((one) => String(one.resource.id))
}

const carried = async (
  db: Db,
  type: string,
  entries: Entries,
  limits: ReadonlyArray<Limit>
): Promise<ReadonlyArray<string>> => {
  const found = await result(db, type, entries, limits)
  return found.entry
    .filter((one) => one.mode === "include")
    .map((one) => `${one.resource.resourceType}/${String(one.resource.id)}`)
    .sort()
}

const tally = async (db: Db, one: Frag): Promise<number> => {
  const sql = `select count(*) as n from (${one.sql}) q`
  const found = await rows(db.connection, sql, one.values)
  return Number(found[0]?.["n"] ?? -1)
}

const patient = (...ids: ReadonlyArray<string>): Limit => ({
  definition: PATIENT,
  ids
})

const BY_PATIENT: Definition = {
  ...PATIENT,
  types: { ...PATIENT.types, Observation: { own: false, params: ["patient"] } }
}

describe("compartment search", () => {
  it("returns exactly the observations in one patient compartment", () =>
    withDb(async (db) => {
      const limits = await run(within(await run(manager()), "patient", "p1", []))
      expect(await matched(db, "Observation", [], limits)).toEqual(["o1"])
    }))

  it("returns the patient the compartment is anchored on", () =>
    withDb(async (db) => {
      expect(await matched(db, "Patient", [], [patient("p1")])).toEqual(["p1"])
    }))

  it("returns nothing for a type the compartment does not place", () =>
    withDb(async (db) => {
      const limits = await run(within(await run(manager()), "encounter", "e1", []))
      expect(await matched(db, "Patient", [], limits)).toEqual([])
      expect((await built("Patient", [], limits)).count.sql).toContain("false")
    }))

  it("narrows to the intersection when a grant and a path disagree", () =>
    withDb(async (db) => {
      const limits = await run(
        within(await run(manager()), "patient", "p2", [patient("p1")])
      )
      expect(await matched(db, "Observation", [], limits)).toEqual([])
    }))

  it("takes every compartment the grant names", () =>
    withDb(async (db) => {
      expect(await matched(db, "Observation", [], [patient("p1", "p2")]))
        .toEqual(["o1", "o2"])
    }))

  it("follows a definition changed after start", () =>
    withDb(async (db) => {
      const held = await run(manager())
      await run(held.put(BY_PATIENT))
      const limits = await run(within(held, "patient", "p1", []))
      expect(await matched(db, "Observation", [], limits)).toEqual([])
    }))
})

describe("no result outside the grant, a plain search", () => {
  it("leaves out a resource in another compartment", () =>
    withDb(async (db) => {
      expect(await matched(db, "Observation", [["code", "vital"]], [])).toEqual([
        "o1",
        "o2"
      ])
      expect(await matched(db, "Observation", [["code", "vital"]], [patient("p1")]))
        .toEqual(["o1"])
    }))

  it("carries the restriction in the query and counts it there", () =>
    withDb(async (db) => {
      const one = await built("Observation", [["code", "vital"]], [patient("p1")])
      expect(one.count.sql).toContain("index_reference")
      expect(one.count.sql).toContain("target_id = ?")
      expect(one.count.values).toContain("p1")
      const found = await result(db, "Observation", [["code", "vital"]], [patient("p1")])
      expect(await tally(db, one.page)).toBe(1)
      expect(found.total).toBe(1)
      expect(found.entry.filter((entry) => entry.mode === "match")).toHaveLength(1)
    }))
})

describe("no result outside the grant, includes", () => {
  const ask: Entries = [
    ["_id", "o1"],
    ["_include", "Observation:encounter"]
  ]

  it("would reach outside the grant when nothing restricts it", () =>
    withDb(async (db) => {
      expect(await carried(db, "Observation", ask, [])).toEqual([
        "Encounter/e1",
        "Encounter/e2"
      ])
    }))

  it("leaves out an included resource in another compartment", () =>
    withDb(async (db) => {
      expect(await carried(db, "Observation", ask, [patient("p1")]))
        .toEqual(["Encounter/e1"])
    }))

  it("restricts the include in the query, and the database counts the answer", () =>
    withDb(async (db) => {
      const one = await built("Observation", ask, [patient("p1")])
      const step = one.include
      expect(step?.sql).toContain("k0.target_id = ?")
      expect(step?.values).toContain("p1")
      expect(await tally(db, step ?? { sql: "select 1", values: [] })).toBe(1)
      expect(await carried(db, "Observation", ask, [patient("p1")])).toHaveLength(1)
    }))

  it("leaves out a resource reached only by a wildcard include", () =>
    withDb(async (db) => {
      const wild: Entries = [
        ["_id", "o1"],
        ["_include", "*"]
      ]
      expect(await carried(db, "Observation", wild, [patient("p1")])).toEqual([
        "Encounter/e1",
        "Patient/p1"
      ])
    }))

  it("holds the restriction on every round of an iterating include", () =>
    withDb(async (db) => {
      const deep: Entries = [
        ["_id", "o1"],
        ["_include", "Observation:encounter"],
        ["_include:iterate", "Encounter:subject"]
      ]
      expect(await carried(db, "Observation", deep, [patient("p1")])).toEqual([
        "Encounter/e1",
        "Patient/p1"
      ])
    }))

  it("leaves out a resource the compartment definition no longer places", () =>
    withDb(async (db) => {
      const back: Entries = [
        ["_id", "p1"],
        ["_revinclude", "Observation:subject"]
      ]
      expect(await carried(db, "Patient", back, [patient("p1")])).toEqual([
        "Observation/o1"
      ])
      const limits = [{ definition: BY_PATIENT, ids: ["p1"] }]
      const one = await built("Patient", back, limits)
      expect(one.revinclude?.values).toContain("p1")
      expect(await tally(db, one.revinclude ?? { sql: "select 1", values: [] })).toBe(0)
      expect(await carried(db, "Patient", back, limits)).toEqual([])
    }))
})

describe("no result outside the grant, chaining", () => {
  const chain: Entries = [["encounter.status", "finished"]]

  it("would report on a resource outside the grant when nothing restricts it", () =>
    withDb(async (db) => {
      expect(await matched(db, "Observation", chain, [])).toEqual(["o1"])
    }))

  it("does not let the chain reach an encounter in another compartment", () =>
    withDb(async (db) => {
      expect(await matched(db, "Observation", chain, [patient("p1")])).toEqual([])
    }))

  it("still follows a chain that stays inside the grant", () =>
    withDb(async (db) => {
      expect(
        await matched(db, "Observation", [["encounter.status", "planned"]], [patient("p1")])
      ).toEqual(["o1"])
    }))

  it("restricts both ends of the chain in the query", () =>
    withDb(async (db) => {
      const one = await built("Observation", chain, [patient("p1")])
      expect(one.count.values.filter((value) => value === "p1").length)
        .toBeGreaterThanOrEqual(2)
      expect(await tally(db, one.page)).toBe(0)
      expect(await matched(db, "Observation", chain, [patient("p1")])).toHaveLength(0)
    }))

  it("does not let a reverse chain report a resource outside the grant", () =>
    withDb(async (db) => {
      const back: Entries = [["_has:Observation:subject:code", "vital"]]
      expect(await matched(db, "Patient", back, [patient("p1")])).toEqual(["p1"])
      expect(await matched(db, "Patient", back, [{ definition: BY_PATIENT, ids: ["p1"] }]))
        .toEqual([])
    }))
})

describe("scoped search keeps the controls it is given", () => {
  it("counts nothing when no total is asked for", () =>
    withDb(async (db) => {
      const found = await result(db, "Observation", [["_total", "none"]], [patient("p1")])
      expect(found.total).toBeUndefined()
    }))

  it("pages inside the restriction", () =>
    withDb(async (db) => {
      const found = await run(
        Effect.flatMap(parse("Observation", []), (query) =>
          scoped(db.connection, query, [patient("p1", "p2")], { limit: 1, offset: 1 })
        )
      )
      expect(found.entry.map((one) => String(one.resource.id))).toEqual(["o2"])
      expect(found.total).toBe(2)
    }))

  it("searches without a restriction when the grant imposes none", () =>
    withDb(async (db) => {
      expect(await matched(db, "Observation", [], [])).toEqual(["o1", "o2"])
    }))
})

describe("scoped search over a compound expression", () => {
  it("restricts every branch of an and and an or", () =>
    withDb(async (db) => {
      const both: Entries = [
        ["code", "vital,resting"],
        ["encounter.status", "finished"]
      ]
      expect(await matched(db, "Observation", both, [])).toEqual(["o1"])
      expect(await matched(db, "Observation", both, [patient("p1")])).toEqual([])
    }))

  it("restricts an include narrowed to one target type", () =>
    withDb(async (db) => {
      const ask: Entries = [
        ["_id", "o1"],
        ["_include", "Observation:subject:Patient"]
      ]
      expect(await carried(db, "Observation", ask, [patient("p1")]))
        .toEqual(["Patient/p1"])
    }))

  it("reports the store unavailable when the query cannot run", async () => {
    const db = await database()
    await seeded(db)
    db.connection.closeSync()
    const found = await Effect.runPromiseExit(
      Effect.flatMap(parse("Observation", []), (query) =>
        scoped(db.connection, query, [patient("p1")])
      )
    )
    expect(
      Exit.isFailure(found) && found.cause._tag === "Fail"
        ? (found.cause.error as { _tag: string })._tag
        : ""
    ).toBe("Unavailable")
  })
})
