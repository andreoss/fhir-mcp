import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Versions } from "../core/interactions.js"
import type { Criteria, Version, VersionedStore } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import { Conflict, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf, walk } from "../store/definitions.js"
import { decode, encode, lazy, pack, unpack } from "./codec.js"
import { changeOf, feedOn } from "./feed.js"
import type { Feed } from "./feed.js"
import { translate } from "./retry.js"

export interface Documents extends VersionedStore {
  readonly feed: Feed
  readonly bytes: (type: string, id: string) => Effect.Effect<number, Failure>
  readonly documents: () => Effect.Effect<number, Failure>
}

interface Doc {
  readonly type: string
  readonly id: string
  readonly versions: ReadonlyArray<Version>
}

const STATEMENTS: ReadonlyArray<string> = [
  `create sequence if not exists document_seq start 1`,
  `create table if not exists document (
     key varchar primary key,
     seq bigint not null,
     resource_type varchar not null,
     logical_id varchar not null,
     version_id integer not null,
     deleted boolean not null,
     terms varchar not null,
     doc varchar not null
   )`,
  `create index if not exists document_lookup
     on document (resource_type, deleted)`
]

const MARK = "\u001f"

const keyOf = (type: string, id: string) => `${type}/${id}`

const probe = (name: string, value: string) => `${MARK}${name}=${value}${MARK}`

const termsOf = (type: string, body: FhirResource): string => {
  const definitions = parametersOf(type)
  if (definitions === undefined) return MARK
  const found = Object.entries(definitions).flatMap(([name, definition]) =>
    walk(body, definition.path).map((value) => `${name}=${value}`)
  )
  return `${MARK}${found.join(MARK)}${MARK}`
}

const rows = (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = await connection.runAndReadAll(sql, [...values] as never)
      return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
    },
    catch: translate
  })

const versionOf = (doc: Doc, versionId: number): Version | undefined =>
  doc.versions.find((one) => one.versionId === versionId)

const make = (
  connection: DuckDBConnection,
  feed: Feed
): Documents & { readonly migrate: Effect.Effect<void, Failure> } => {
  let last = 0

  const ask = (sql: string, values: ReadonlyArray<unknown> = []) =>
    rows(connection, sql, values)

  const atomic = <A>(work: Effect.Effect<A, Failure>) =>
    ask("begin transaction").pipe(
      Effect.zipRight(work),
      Effect.tap(() => ask("commit")),
      Effect.tapError(() => Effect.ignore(ask("rollback")))
    )

  const declared = (type: string, criteria: Criteria) => {
    const definitions = parametersOf(type)
    if (definitions === undefined) {
      return Effect.fail(
        new Rejected({ reason: `unsupported resource type: ${type}` })
      )
    }
    const unknown = criteria
      .map(([name]) => name)
      .filter((name) => definitions[name] === undefined)
    return unknown.length > 0
      ? Effect.fail(
          new Rejected({
            reason: `unsupported criterion: ${unknown.join(", ")}`
          })
        )
      : Effect.void
  }

  const rowAt = (type: string, id: string) =>
    ask(
      `select version_id, deleted, doc from document where key = ?`,
      [keyOf(type, id)]
    ).pipe(Effect.map((found) => found[0]))

  const docOf = (row: Record<string, unknown>) =>
    unpack<Doc>(decode(String(row["doc"])))

  const held = (type: string, id: string) =>
    Effect.gen(function* () {
      const row = yield* rowAt(type, id)
      if (row === undefined) return undefined
      return yield* docOf(row)
    })

  const store = (doc: Doc, entry: Version) =>
    Effect.gen(function* () {
      const text = encode(yield* pack(doc))
      const terms = entry.deleted ? MARK : termsOf(entry.type, entry.body)
      yield* atomic(
        Effect.gen(function* () {
          yield* ask(`delete from document where key = ?`, [
            keyOf(doc.type, doc.id)
          ])
          yield* ask(
            `insert into document (key, seq, resource_type, logical_id,
               version_id, deleted, terms, doc)
             values (?, nextval('document_seq'), ?, ?, ?, ?, ?, ?)`,
            [
              keyOf(doc.type, doc.id),
              doc.type,
              doc.id,
              entry.versionId,
              entry.deleted,
              terms,
              text
            ]
          )
        })
      )
    })

  const current = (type: string, id: string) =>
    Effect.gen(function* () {
      const row = yield* rowAt(type, id)
      if (row === undefined) return undefined
      const doc = yield* docOf(row)
      return versionOf(doc, Number(row["version_id"]))
    })

  const versionAt = (type: string, id: string, versionId: number) =>
    Effect.map(held(type, id), (doc) =>
      doc === undefined ? undefined : versionOf(doc, versionId)
    )

  const history = (type: string, id: string) =>
    Effect.map(held(type, id), (doc) =>
      doc === undefined
        ? []
        : [...doc.versions].sort((a, b) => b.versionId - a.versionId)
    )

  const insertVersion = (entry: Version) =>
    Effect.gen(function* () {
      const doc = (yield* held(entry.type, entry.id)) ?? {
        type: entry.type,
        id: entry.id,
        versions: [] as ReadonlyArray<Version>
      }
      if (versionOf(doc, entry.versionId) !== undefined) {
        return yield* Effect.fail(
          new Conflict({ reason: "version already written" })
        )
      }
      yield* store({ ...doc, versions: [...doc.versions, entry] }, entry)
      yield* feed.append({
        type: entry.type,
        id: entry.id,
        versionId: entry.versionId,
        kind: changeOf(entry.versionId, entry.deleted),
        at: entry.lastUpdated
      })
    })

  const markDeleted = (
    type: string,
    id: string,
    versionId: number,
    lastUpdated: string
  ) =>
    insertVersion({
      type,
      id,
      versionId,
      lastUpdated,
      deleted: true,
      body: { resourceType: type, id }
    })

  const purge = (type: string, id: string) =>
    Effect.asVoid(
      ask(`delete from document where key = ?`, [keyOf(type, id)])
    )

  const matching = (type: string, criteria: Criteria) =>
    Effect.gen(function* () {
      yield* declared(type, criteria)
      const values: Array<unknown> = [type]
      const clauses = criteria.map(([name, value]) => {
        values.push(probe(name, value))
        return `contains(terms, ?)`
      })
      const where = ["resource_type = ?", "not deleted", ...clauses]
        .join(" and ")
      const found = yield* ask(
        `select version_id, doc from document where ${where} order by seq`,
        values
      )
      const seen = yield* Effect.forEach(found, (row) =>
        Effect.map(docOf(row), (doc) =>
          versionOf(doc, Number(row["version_id"]))
        )
      )
      return seen.filter((one): one is Version => one !== undefined)
    })

  const bytes = (type: string, id: string) =>
    Effect.map(rowAt(type, id), (row) =>
      row === undefined ? 0 : lazy(decode(String(row["doc"]))).bytes
    )

  const documents = () =>
    ask(`select count(*) as n from document`).pipe(
      Effect.map((found) => Number(found[0]?.["n"] ?? 0))
    )

  const mint = () => Effect.sync(() => randomUUID())

  const stamp = () =>
    Effect.sync(() => {
      const now = Date.now()
      last = now > last ? now : last + 1
      return new Date(last).toISOString()
    })

  const migrate = Effect.forEach(STATEMENTS, (statement) => ask(statement), {
    discard: true
  })

  return {
    current,
    versionAt,
    history,
    insertVersion,
    markDeleted,
    purge,
    matching,
    mint,
    stamp,
    feed,
    bytes,
    documents,
    migrate
  }
}

export const documentsOn = (
  connection: DuckDBConnection
): Effect.Effect<Documents, Failure> =>
  Effect.gen(function* () {
    const feed = yield* feedOn(connection)
    const store = make(connection, feed)
    return yield* Effect.as(store.migrate, store)
  })

export const open = (
  path: string
): Effect.Effect<Documents, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: translate
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(Effect.flatMap(documentsOn))

export const layer = (path: string): Layer.Layer<Versions, Failure> =>
  Layer.scoped(Versions, open(path))
