import { Effect } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { Failure } from "../core/outcome.js"
import { translate } from "./retry.js"

export type Kind = "create" | "update" | "delete"

export interface Entry {
  readonly type: string
  readonly id: string
  readonly versionId: number
  readonly kind: Kind
  readonly at: string
}

export interface Logged extends Entry {
  readonly seq: number
}

export interface Feed {
  readonly append: (entry: Entry) => Effect.Effect<number, Failure>
  readonly since: (
    seq: number,
    limit?: number
  ) => Effect.Effect<ReadonlyArray<Logged>, Failure>
  readonly head: Effect.Effect<number, Failure>
}

const STATEMENTS: ReadonlyArray<string> = [
  `create table if not exists change_feed (
     seq bigint primary key,
     resource_type varchar not null,
     logical_id varchar not null,
     version_id integer not null,
     kind varchar not null,
     moment timestamp not null
   )`,
  `create unique index if not exists change_feed_once
     on change_feed (resource_type, logical_id, version_id)`
]

const MOMENT = "'%Y-%m-%dT%H:%M:%S.%gZ'"

const FIELDS = `seq, resource_type as type, logical_id as id, version_id,
  kind, strftime(moment, ${MOMENT}) as moment`

export const changeOf = (versionId: number, deleted: boolean): Kind =>
  deleted ? "delete" : versionId <= 1 ? "create" : "update"

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

const loggedOf = (row: Record<string, unknown>): Logged => ({
  seq: Number(row["seq"]),
  type: String(row["type"]),
  id: String(row["id"]),
  versionId: Number(row["version_id"]),
  kind: String(row["kind"]) as Kind,
  at: String(row["moment"])
})

export const feedOn = (
  connection: DuckDBConnection
): Effect.Effect<Feed, Failure> =>
  Effect.gen(function* () {
    const ask = (sql: string, values: ReadonlyArray<unknown> = []) =>
      rows(connection, sql, values)

    yield* Effect.forEach(STATEMENTS, (statement) => ask(statement), {
      discard: true
    })

    const permit = yield* Effect.makeSemaphore(1)

    const head = ask(
      `select coalesce(max(seq), 0) as seq from change_feed`
    ).pipe(Effect.map((found) => Number(found[0]?.["seq"] ?? 0)))

    const seqOf = (entry: Entry) =>
      ask(
        `select seq from change_feed
         where resource_type = ? and logical_id = ? and version_id = ?`,
        [entry.type, entry.id, entry.versionId]
      ).pipe(
        Effect.map((found) => {
          const row = found[0]
          return row === undefined ? undefined : Number(row["seq"])
        })
      )

    const append = (entry: Entry) =>
      permit.withPermits(1)(
        Effect.gen(function* () {
          const written = yield* seqOf(entry)
          if (written !== undefined) return written
          const seq = (yield* head) + 1
          yield* ask(
            `insert into change_feed
               (seq, resource_type, logical_id, version_id, kind, moment)
             values (?, ?, ?, ?, ?, ?)`,
            [seq, entry.type, entry.id, entry.versionId, entry.kind, entry.at]
          )
          return seq
        })
      )

    const since = (seq: number, limit?: number) =>
      ask(
        `select ${FIELDS} from change_feed where seq > ? order by seq` +
          (limit === undefined ? "" : ` limit ?`),
        limit === undefined ? [seq] : [seq, limit]
      ).pipe(Effect.map((found) => found.map(loggedOf)))

    return { append, since, head }
  })

export const open = (
  path: string
): Effect.Effect<Feed, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: translate
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(Effect.flatMap(feedOn))
