import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { parse } from "../search/parse.js"
import { ensure, execute, index, plan } from "./query.js"
import type { IndexEntry } from "./query.js"

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

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

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
    type: string,
    id: string,
    body?: Record<string, unknown>,
    options?: { readonly deleted?: boolean; readonly at?: string }
  ) => Promise<bigint>
  readonly text: (
    surrogate: bigint,
    type: string,
    name: string,
    value: string
  ) => Promise<void>
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
  const put = async (
    type: string,
    id: string,
    body: Record<string, unknown> = {},
    options: { readonly deleted?: boolean; readonly at?: string } = {}
  ) => {
    const at = (options.at ?? "2024-01-01T00:00:00.000Z").replace("T", " ").replace("Z", "")
    const found = await rows(
      connection,
      `insert into resource
         (surrogate_id, resource_type, logical_id, version_id,
          last_updated, deleted, is_current, body)
       values (nextval('surrogate_id'), ?, ?, 1, cast(? as timestamp), ?, true, ?)
       returning surrogate_id`,
      [type, id, at, options.deleted === true, JSON.stringify({ resourceType: type, id, ...body })]
    )
    return BigInt(String(found[0]?.["surrogate_id"]))
  }
  const text = async (surrogate: bigint, type: string, name: string, value: string) => {
    await rows(
      connection,
      `insert into resource_index (surrogate_id, resource_type, name, value)
       values (?, ?, ?, ?)`,
      [surrogate, type, name, value]
    )
  }
  const entries = (surrogate: bigint, type: string, list: ReadonlyArray<IndexEntry>) =>
    run(index(connection, surrogate, type, list))
  return { connection, put, text, entries }
}

const withDb = async (use: (db: Db) => Promise<void>): Promise<void> => {
  const db = await database()
  try {
    await use(db)
  } finally {
    db.connection.closeSync()
  }
}

const search = (
  db: Db,
  type: string,
  entries: ReadonlyArray<readonly [string, string]>,
  paging: { readonly offset?: number; readonly limit?: number } = {}
) => run(Effect.flatMap(parse(type, entries), (query) => execute(db.connection, query, paging)))

const found = async (
  db: Db,
  type: string,
  entries: ReadonlyArray<readonly [string, string]>
): Promise<ReadonlyArray<string>> => {
  const result = await search(db, type, entries)
  return result.entry.filter((one) => one.mode === "match").map((one) => String(one.resource.id))
}

const included = async (
  db: Db,
  type: string,
  entries: ReadonlyArray<readonly [string, string]>
): Promise<ReadonlyArray<string>> => {
  const result = await search(db, type, entries)
  return result.entry
    .filter((one) => one.mode === "include")
    .map((one) => `${one.resource.resourceType}/${String(one.resource.id)}`)
}

const refused = (db: Db, type: string, entries: ReadonlyArray<readonly [string, string]>) =>
  exit(Effect.flatMap(parse(type, entries), (query) => execute(db.connection, query, {})))

const named = async (db: Db, id: string, family: string): Promise<bigint> => {
  const surrogate = await db.put("Patient", id, { name: [{ family }] })
  await db.text(surrogate, "Patient", "family", family)
  return surrogate
}

describe("query, values are always bound", () => {
  it("cannot be steered by a value carrying a quote and a comment marker", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      const hostile = "' or 1=1 --"
      const built = await run(
        Effect.flatMap(parse("Patient", [["family", hostile]]), (query) => plan(query, {}))
      )
      expect(built.count.sql).not.toContain("'")
      expect(built.count.sql).not.toContain("--")
      expect(built.count.values).toContain(hostile)
      expect(await found(db, "Patient", [["family", hostile]])).toEqual([])
    }))

  it("keeps a value with a quote out of the emitted text on every kind", () =>
    withDb(async (db) => {
      const surrogate = await db.put("Observation", "o1")
      await db.entries(surrogate, "Observation", [
        { kind: "token", name: "code", system: "s", code: "c", text: undefined }
      ])
      const built = await run(
        Effect.flatMap(parse("Observation", [["code", "s|'; drop table resource; --"]]), (query) =>
          plan(query, {})
        )
      )
      expect(built.page.sql).not.toContain("drop table")
      expect(await found(db, "Observation", [["code", "s|'; drop table resource; --"]])).toEqual([])
      expect((await rows(db.connection, "select count(*) as n from resource"))[0]?.["n"]).toBe(1n)
    }))
})

describe("query, string values", () => {
  it("matches the start of a string without regard to case", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      await named(db, "p2", "Flanders")
      expect(await found(db, "Patient", [["family", "simp"]])).toEqual(["p1"])
    }))

  it("matches the whole string only when exact is asked for", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      expect(await found(db, "Patient", [["family:exact", "Simpson"]])).toEqual(["p1"])
      expect(await found(db, "Patient", [["family:exact", "simpson"]])).toEqual([])
    }))

  it("matches anywhere in the string when contains is asked for", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      expect(await found(db, "Patient", [["family:contains", "mpso"]])).toEqual(["p1"])
    }))
})

describe("query, token values", () => {
  const coded = async (db: Db, id: string, system: string | undefined, code: string) => {
    const surrogate = await db.put("Patient", id)
    await db.entries(surrogate, "Patient", [
      { kind: "token", name: "gender", system, code, text: `${code} display` }
    ])
    return surrogate
  }

  it("matches a bare code in any system", () =>
    withDb(async (db) => {
      await coded(db, "p1", "http://s", "male")
      await coded(db, "p2", "http://s", "female")
      expect(await found(db, "Patient", [["gender", "male"]])).toEqual(["p1"])
    }))

  it("matches a system and code together", () =>
    withDb(async (db) => {
      await coded(db, "p1", "http://s", "male")
      await coded(db, "p2", "http://other", "male")
      expect(await found(db, "Patient", [["gender", "http://s|male"]])).toEqual(["p1"])
    }))

  it("matches every code in a system when the code is left out", () =>
    withDb(async (db) => {
      await coded(db, "p1", "http://s", "male")
      await coded(db, "p2", "http://other", "female")
      expect(await found(db, "Patient", [["gender", "http://s|"]])).toEqual(["p1"])
    }))

  it("matches a code with no system when the system is left out", () =>
    withDb(async (db) => {
      await coded(db, "p1", undefined, "male")
      await coded(db, "p2", "http://s", "male")
      expect(await found(db, "Patient", [["gender", "|male"]])).toEqual(["p1"])
    }))

  it("searches the display text of a token", () =>
    withDb(async (db) => {
      await coded(db, "p1", "http://s", "male")
      expect(await found(db, "Patient", [["gender:text", "male disp"]])).toEqual(["p1"])
    }))

  it("returns a resource carrying no entry at all for not", () =>
    withDb(async (db) => {
      await coded(db, "p1", "http://s", "male")
      await coded(db, "p2", "http://s", "female")
      await db.put("Patient", "p3")
      expect(await found(db, "Patient", [["gender:not", "male"]])).toEqual(["p2", "p3"])
    }))

  it("states the absence of an entry rather than an unmatched entry", () =>
    withDb(async (db) => {
      await coded(db, "p1", "http://s", "male")
      const built = await run(
        Effect.flatMap(parse("Patient", [["gender:not", "male"]]), (query) => plan(query, {}))
      )
      expect(built.count.sql).toContain("not exists")
      expect(built.count.sql).not.toContain("not in")
    }))

  it("finds by logical id and by type", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      await named(db, "p2", "Simpson")
      expect(await found(db, "Patient", [["_id", "p2"]])).toEqual(["p2"])
      expect(await found(db, "Patient", [["_type", "Patient"]])).toEqual(["p1", "p2"])
      expect(await found(db, "Patient", [["_id:not", "p2"]])).toEqual(["p1"])
    }))
})

describe("query, ordered values", () => {
  const measured = async (db: Db, id: string, value: number) => {
    const surrogate = await db.put("Encounter", id)
    await db.entries(surrogate, "Encounter", [{ kind: "number", name: "length", value }])
  }

  it("compares a number with every ordering prefix", () =>
    withDb(async (db) => {
      await measured(db, "e1", 10)
      await measured(db, "e2", 20)
      await measured(db, "e3", 30)
      expect(await found(db, "Encounter", [["length", "20"]])).toEqual(["e2"])
      expect(await found(db, "Encounter", [["length", "gt20"]])).toEqual(["e3"])
      expect(await found(db, "Encounter", [["length", "lt20"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["length", "ge20"]])).toEqual(["e2", "e3"])
      expect(await found(db, "Encounter", [["length", "le20"]])).toEqual(["e1", "e2"])
      expect(await found(db, "Encounter", [["length", "sa20"]])).toEqual(["e3"])
      expect(await found(db, "Encounter", [["length", "eb20"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["length", "ap20"]])).toEqual(["e2"])
    }))

  it("treats ne on a number as the absence of an equal entry", () =>
    withDb(async (db) => {
      await measured(db, "e1", 10)
      await measured(db, "e2", 20)
      await db.put("Encounter", "e3")
      expect(await found(db, "Encounter", [["length", "ne20"]])).toEqual(["e1", "e3"])
    }))

  it("compares a quantity with its unit", () =>
    withDb(async (db) => {
      const one = await db.put("Observation", "o1")
      await db.entries(one, "Observation", [
        { kind: "quantity", name: "value-quantity", value: 6.2, system: "http://u", code: "mg" }
      ])
      const two = await db.put("Observation", "o2")
      await db.entries(two, "Observation", [
        { kind: "quantity", name: "value-quantity", value: 6.2, system: "http://u", code: "kg" }
      ])
      expect(await found(db, "Observation", [["value-quantity", "gt6|http://u|mg"]]))
        .toEqual(["o1"])
      expect(await found(db, "Observation", [["value-quantity", "6.2"]])).toEqual(["o1", "o2"])
    }))
})

describe("query, date values", () => {
  const dated = async (db: Db, id: string, low: string, high: string) => {
    const surrogate = await db.put("Encounter", id)
    await db.entries(surrogate, "Encounter", [{ kind: "date", name: "date", low, high }])
  }

  it("compares a stored range against the range the value denotes", () =>
    withDb(async (db) => {
      await dated(db, "e1", "2024-03-05T00:00:00.000Z", "2024-03-06T00:00:00.000Z")
      await dated(db, "e2", "2024-04-05T00:00:00.000Z", "2024-04-06T00:00:00.000Z")
      expect(await found(db, "Encounter", [["date", "2024-03"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["date", "2024-03-05"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["date", "2024"]])).toEqual(["e1", "e2"])
    }))

  it("orders a range against a value with the ordering prefixes", () =>
    withDb(async (db) => {
      await dated(db, "e1", "2024-03-05T00:00:00.000Z", "2024-03-06T00:00:00.000Z")
      await dated(db, "e2", "2024-04-05T00:00:00.000Z", "2024-04-06T00:00:00.000Z")
      expect(await found(db, "Encounter", [["date", "gt2024-03-31"]])).toEqual(["e2"])
      expect(await found(db, "Encounter", [["date", "lt2024-04-01"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["date", "ge2024-04-05"]])).toEqual(["e2"])
      expect(await found(db, "Encounter", [["date", "le2024-03-05"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["date", "sa2024-03-31"]])).toEqual(["e2"])
      expect(await found(db, "Encounter", [["date", "eb2024-04-01"]])).toEqual(["e1"])
      expect(await found(db, "Encounter", [["date", "ne2024-03-05"]])).toEqual(["e2"])
      expect(await found(db, "Encounter", [["date", "ap2024-03-05"]])).toEqual(["e1"])
    }))

  it("compares the stamp the store keeps for last updated", () =>
    withDb(async (db) => {
      await db.put("Patient", "p1", {}, { at: "2024-01-01T00:00:00.000Z" })
      await db.put("Patient", "p2", {}, { at: "2025-06-01T00:00:00.000Z" })
      expect(await found(db, "Patient", [["_lastUpdated", "2024"]])).toEqual(["p1"])
      expect(await found(db, "Patient", [["_lastUpdated", "gt2024-12-31"]])).toEqual(["p2"])
    }))
})

describe("query, references and addresses", () => {
  const observed = async (
    db: Db,
    id: string,
    entry: IndexEntry
  ) => {
    const surrogate = await db.put("Observation", id)
    await db.entries(surrogate, "Observation", [entry])
  }

  it("matches a reference by bare id, by typed id and by address", () =>
    withDb(async (db) => {
      await observed(db, "o1", {
        kind: "reference",
        name: "subject",
        targetType: "Patient",
        targetId: "p1",
        url: "http://e/Patient/p1",
        idSystem: undefined,
        idCode: undefined
      })
      await observed(db, "o2", {
        kind: "reference",
        name: "subject",
        targetType: "Device",
        targetId: "p1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      })
      expect(await found(db, "Observation", [["subject", "p1"]])).toEqual(["o1", "o2"])
      expect(await found(db, "Observation", [["subject", "Patient/p1"]])).toEqual(["o1"])
      expect(await found(db, "Observation", [["subject:Patient", "p1"]])).toEqual(["o1"])
      expect(await found(db, "Observation", [["subject", "http://e/Patient/p1"]])).toEqual(["o1"])
    }))

  it("matches a reference carried as an identifier", () =>
    withDb(async (db) => {
      await observed(db, "o1", {
        kind: "reference",
        name: "subject",
        targetType: undefined,
        targetId: undefined,
        url: undefined,
        idSystem: "http://mrn",
        idCode: "42"
      })
      await observed(db, "o2", {
        kind: "reference",
        name: "subject",
        targetType: undefined,
        targetId: undefined,
        url: undefined,
        idSystem: undefined,
        idCode: "42"
      })
      expect(await found(db, "Observation", [["subject:identifier", "http://mrn|42"]]))
        .toEqual(["o1"])
      expect(await found(db, "Observation", [["subject:identifier", "42"]])).toEqual(["o1", "o2"])
      expect(await found(db, "Observation", [["subject:identifier", "|42"]])).toEqual(["o2"])
    }))

  it("matches an address exactly, below it and above it", () =>
    withDb(async (db) => {
      const one = await db.put("Patient", "p1")
      await db.text(one, "Patient", "_profile", "http://e/StructureDefinition/one")
      const two = await db.put("Patient", "p2")
      await db.text(two, "Patient", "_profile", "http://other/two")
      expect(await found(db, "Patient", [["_profile", "http://e/StructureDefinition/one"]]))
        .toEqual(["p1"])
      expect(await found(db, "Patient", [["_profile:below", "http://e/"]])).toEqual(["p1"])
      expect(await found(db, "Patient", [["_profile:above", "http://other/two/three"]]))
        .toEqual(["p2"])
      expect(await found(db, "Patient", [["_profile:contains", "OTHER"]])).toEqual(["p2"])
    }))
})

describe("query, missing", () => {
  it("separates the resources carrying a value from those that do not", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      await db.put("Patient", "p2")
      expect(await found(db, "Patient", [["family:missing", "true"]])).toEqual(["p2"])
      expect(await found(db, "Patient", [["family:missing", "false"]])).toEqual(["p1"])
    }))

  it("treats a stamp the store always writes as never missing", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      expect(await found(db, "Patient", [["_lastUpdated:missing", "false"]])).toEqual(["p1"])
      expect(await found(db, "Patient", [["_id:missing", "true"]])).toEqual([])
    }))

  it("looks in the index a reference parameter is kept in", () =>
    withDb(async (db) => {
      const one = await db.put("Observation", "o1")
      await db.entries(one, "Observation", [
        {
          kind: "reference",
          name: "patient",
          targetType: "Patient",
          targetId: "p1",
          url: undefined,
          idSystem: undefined,
          idCode: undefined
        }
      ])
      await db.put("Observation", "o2")
      expect(await found(db, "Observation", [["patient:missing", "true"]])).toEqual(["o2"])
    }))
})

describe("query, combining terms", () => {
  it("requires every parameter and any of the values one parameter names", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      await named(db, "p2", "Flanders")
      await named(db, "p3", "Wiggum")
      expect(await found(db, "Patient", [["family", "Simpson,Flanders"]])).toEqual(["p1", "p2"])
      expect(await found(db, "Patient", [["family", "Simpson,Flanders"], ["_id", "p2"]]))
        .toEqual(["p2"])
    }))

  it("returns every resource of the type when nothing is asked of it", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      await named(db, "p2", "Flanders")
      const result = await search(db, "Patient", [])
      expect(result.total).toBe(2)
    }))

  it("never returns a deleted resource", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      const gone = await db.put("Patient", "p2", { name: [{ family: "Simpson" }] }, { deleted: true })
      await db.text(gone, "Patient", "family", "Simpson")
      expect(await found(db, "Patient", [["family", "Simpson"]])).toEqual(["p1"])
    }))
})

describe("query, chaining", () => {
  const chained = async (db: Db) => {
    const patient = await named(db, "p1", "Simpson")
    await named(db, "p2", "Flanders")
    const encounter = await db.put("Encounter", "e1")
    await db.entries(encounter, "Encounter", [
      {
        kind: "reference",
        name: "subject",
        targetType: "Patient",
        targetId: "p1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    ])
    const other = await db.put("Encounter", "e2")
    await db.entries(other, "Encounter", [
      {
        kind: "reference",
        name: "subject",
        targetType: "Patient",
        targetId: "p2",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    ])
    const first = await db.put("Observation", "o1")
    await db.entries(first, "Observation", [
      {
        kind: "reference",
        name: "encounter",
        targetType: "Encounter",
        targetId: "e1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    ])
    const second = await db.put("Observation", "o2")
    await db.entries(second, "Observation", [
      {
        kind: "reference",
        name: "encounter",
        targetType: "Encounter",
        targetId: "e2",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    ])
    return { patient, encounter }
  }

  it("follows a single chain", () =>
    withDb(async (db) => {
      await chained(db)
      expect(await found(db, "Encounter", [["subject.family", "Simpson"]])).toEqual(["e1"])
    }))

  it("follows a two level chain", () =>
    withDb(async (db) => {
      await chained(db)
      expect(await found(db, "Observation", [["encounter.subject.family", "Simpson"]]))
        .toEqual(["o1"])
    }))

  it("answers a two level chain entirely in the query", () =>
    withDb(async (db) => {
      await chained(db)
      const built = await run(
        Effect.flatMap(
          parse("Observation", [["encounter.subject.family", "Simpson"]]),
          (query) => plan(query, {})
        )
      )
      const counted = await rows(db.connection, built.count.sql, built.count.values)
      const paged = await rows(db.connection, built.page.sql, built.page.values)
      expect(Number(counted[0]?.["total"])).toBe(1)
      expect(paged).toHaveLength(1)
      expect(String(paged[0]?.["logical_id"])).toBe("o1")
    }))

  it("does not follow a chain into a deleted resource", () =>
    withDb(async (db) => {
      await chained(db)
      await rows(
        db.connection,
        `update resource set deleted = true where resource_type = ? and logical_id = ?`,
        ["Patient", "p1"]
      )
      expect(await found(db, "Observation", [["encounter.subject.family", "Simpson"]])).toEqual([])
    }))

  it("reverses a chain and carries a forward chain inside it", () =>
    withDb(async (db) => {
      await chained(db)
      const first = await db.put("Observation", "o3")
      await db.entries(first, "Observation", [
        {
          kind: "reference",
          name: "patient",
          targetType: "Patient",
          targetId: "p1",
          url: undefined,
          idSystem: undefined,
          idCode: undefined
        },
        {
          kind: "reference",
          name: "encounter",
          targetType: "Encounter",
          targetId: "e1",
          url: undefined,
          idSystem: undefined,
          idCode: undefined
        }
      ])
      expect(await found(db, "Patient", [["_has:Observation:patient:_id", "o3"]])).toEqual(["p1"])
      expect(await found(db, "Patient", [["_has:Observation:patient:encounter.subject.family", "Simpson"]]))
        .toEqual(["p1"])
      expect(await found(db, "Patient", [["_has:Observation:patient:_id", "o1"]])).toEqual([])
    }))
})

describe("query, includes", () => {
  const linked = async (db: Db) => {
    await named(db, "p1", "Simpson")
    const encounter = await db.put("Encounter", "e1")
    await db.entries(encounter, "Encounter", [
      {
        kind: "reference",
        name: "subject",
        targetType: "Patient",
        targetId: "p1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    ])
    const observation = await db.put("Observation", "o1")
    await db.entries(observation, "Observation", [
      {
        kind: "reference",
        name: "encounter",
        targetType: "Encounter",
        targetId: "e1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      },
      {
        kind: "reference",
        name: "patient",
        targetType: "Patient",
        targetId: "p1",
        url: undefined,
        idSystem: undefined,
        idCode: undefined
      }
    ])
  }

  it("brings back the resource a match points at, marked apart from the matches", () =>
    withDb(async (db) => {
      await linked(db)
      const result = await search(db, "Observation", [["_include", "Observation:patient"]])
      expect(result.entry.filter((one) => one.mode === "match").map((one) => one.resource.id))
        .toEqual(["o1"])
      expect(await included(db, "Observation", [["_include", "Observation:patient"]]))
        .toEqual(["Patient/p1"])
    }))

  it("brings back the resources pointing at a match", () =>
    withDb(async (db) => {
      await linked(db)
      expect(await included(db, "Patient", [["_revinclude", "Encounter:subject"]]))
        .toEqual(["Encounter/e1"])
    }))

  it("walks a further level when iterate is asked for", () =>
    withDb(async (db) => {
      await linked(db)
      const names = await included(db, "Observation", [
        ["_include", "Observation:encounter"],
        ["_include:iterate", "Encounter:subject"]
      ])
      expect(names).toContain("Encounter/e1")
      expect(names).toContain("Patient/p1")
    }))

  it("does not repeat a resource reached by two paths", () =>
    withDb(async (db) => {
      await linked(db)
      const names = await included(db, "Observation", [
        ["_include", "Observation:patient"],
        ["_include", "Observation:encounter"],
        ["_include:iterate", "Encounter:subject"]
      ])
      expect(names.filter((one) => one === "Patient/p1")).toHaveLength(1)
    }))

  it("never includes a deleted resource", () =>
    withDb(async (db) => {
      await linked(db)
      await rows(
        db.connection,
        `update resource set deleted = true where resource_type = ? and logical_id = ?`,
        ["Patient", "p1"]
      )
      expect(await included(db, "Observation", [["_include", "Observation:patient"]])).toEqual([])
    }))

  it("takes every reference of a type when a wildcard is given", () =>
    withDb(async (db) => {
      await linked(db)
      const names = await included(db, "Observation", [["_include", "Observation:*"]])
      expect(names).toContain("Patient/p1")
      expect(names).toContain("Encounter/e1")
      const all = await included(db, "Observation", [["_include", "*"]])
      expect(all).toContain("Patient/p1")
    }))

  it("narrows an include to the type it names", () =>
    withDb(async (db) => {
      await linked(db)
      const observation = await db.put("Observation", "o2")
      await db.entries(observation, "Observation", [
        {
          kind: "reference",
          name: "subject",
          targetType: "Patient",
          targetId: "p1",
          url: undefined,
          idSystem: undefined,
          idCode: undefined
        },
        {
          kind: "reference",
          name: "subject",
          targetType: "Encounter",
          targetId: "e1",
          url: undefined,
          idSystem: undefined,
          idCode: undefined
        }
      ])
      const names = await included(db, "Observation", [
        ["_id", "o2"],
        ["_include", "Observation:subject:Patient"]
      ])
      expect(names).toEqual(["Patient/p1"])
    }))

  it("does not offer a match a second time as an include", () =>
    withDb(async (db) => {
      await linked(db)
      const names = await included(db, "Patient", [["_revinclude", "Observation:patient"]])
      expect(names).toEqual(["Observation/o1"])
    }))
})

describe("query, sorting and paging", () => {
  const three = async (db: Db) => {
    await named(db, "p1", "Wiggum")
    await named(db, "p2", "Flanders")
    await named(db, "p3", "Simpson")
  }

  it("sorts by an indexed parameter in both directions", () =>
    withDb(async (db) => {
      await three(db)
      expect(await found(db, "Patient", [["_sort", "family"]])).toEqual(["p2", "p3", "p1"])
      expect(await found(db, "Patient", [["_sort", "-family"]])).toEqual(["p1", "p3", "p2"])
    }))

  it("sorts by the parameters the store keeps on the resource itself", () =>
    withDb(async (db) => {
      await three(db)
      expect(await found(db, "Patient", [["_sort", "_id"]])).toEqual(["p1", "p2", "p3"])
      expect(await found(db, "Patient", [["_sort", "-_lastUpdated,_id"]]))
        .toEqual(["p1", "p2", "p3"])
    }))

  it("pages without skipping or repeating a row", () =>
    withDb(async (db) => {
      await three(db)
      const first = await search(db, "Patient", [["_sort", "family"]], { offset: 0, limit: 2 })
      const second = await search(db, "Patient", [["_sort", "family"]], { offset: 2, limit: 2 })
      const seen = [...first.entry, ...second.entry].map((one) => String(one.resource.id))
      expect(seen).toEqual(["p2", "p3", "p1"])
      expect(first.total).toBe(3)
    }))

  it("pages a set where the sort key is the same for every row", () =>
    withDb(async (db) => {
      await named(db, "p1", "Simpson")
      await named(db, "p2", "Simpson")
      await named(db, "p3", "Simpson")
      const pages = [0, 1, 2].map((offset) =>
        search(db, "Patient", [["_sort", "family"]], { offset, limit: 1 })
      )
      const seen = (await Promise.all(pages)).flatMap((one) =>
        one.entry.map((entry) => String(entry.resource.id))
      )
      expect(new Set(seen).size).toBe(3)
    }))

  it("takes the page size from the result control when none is given", () =>
    withDb(async (db) => {
      await three(db)
      const result = await search(db, "Patient", [["_count", "1"]])
      expect(result.entry).toHaveLength(1)
      expect(result.total).toBe(3)
    }))

  it("leaves the total out when none is asked for", () =>
    withDb(async (db) => {
      await three(db)
      expect((await search(db, "Patient", [["_total", "none"]])).total).toBeUndefined()
    }))
})

describe("query, what the index cannot answer", () => {
  it("refuses rather than widening into a scan", () =>
    withDb(async (db) => {
      expect(tag(await refused(db, "Observation", [["code:in", "http://v/set"]]))).toBe("Rejected")
      expect(tag(await refused(db, "Observation", [["code:not-in", "http://v/set"]])))
        .toBe("Rejected")
      expect(tag(await refused(db, "Observation", [["code:above", "http://s|a"]]))).toBe("Rejected")
      expect(tag(await refused(db, "Observation", [["code:below", "http://s|a"]]))).toBe("Rejected")
      expect(tag(await refused(db, "Patient", [["identifier:of-type", "s|c|v"]]))).toBe("Rejected")
      expect(
        tag(await refused(db, "Observation", [["code-value-quantity", "http://s|a$5"]]))
      ).toBe("Rejected")
      expect(tag(await refused(db, "Observation", [["subject:below", "Patient/p1"]])))
        .toBe("Rejected")
      expect(tag(await refused(db, "Patient", [["_id", "http://s|p1"]]))).toBe("Rejected")
    }))

  it("refuses a sort over a parameter it cannot order", () =>
    withDb(async (db) => {
      expect(tag(await refused(db, "Observation", [["_sort", "code-value-quantity"]])))
        .toBe("Rejected")
    }))

  it("reports a store that answers nothing as an unavailable dependency", async () => {
    const db = await database()
    db.connection.closeSync()
    const failed = await exit(
      Effect.flatMap(parse("Patient", []), (query) => execute(db.connection, query, {}))
    )
    expect(tag(failed)).toBe("Unavailable")
    expect(tag(await exit(ensure(db.connection)))).toBe("Unavailable")
  })
})
