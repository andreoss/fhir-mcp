import { Clock, Effect } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { GENESIS, audit, digestOf, write } from "./chain.js"
import type { Entry, Held, Line, Outcome, Report } from "./chain.js"
import { anchorOf, sealOf } from "./seal.js"
import type { Anchor, Seal } from "./seal.js"

export const STATEMENTS: ReadonlyArray<string> = [
  `create table if not exists trail_line (
     seq bigint primary key,
     moment bigint not null,
     actor varchar not null,
     action varchar not null,
     resource varchar not null,
     outcome varchar not null,
     correlation varchar not null,
     prev varchar not null,
     digest varchar not null
   )`,
  `create table if not exists trail_seal (
     seq bigint primary key,
     digest varchar not null,
     moment bigint not null,
     mac varchar not null
   )`,
  `create table if not exists trail_anchor (
     seq bigint primary key,
     prev varchar not null,
     through bigint not null,
     mac varchar not null
   )`,
  `create index if not exists trail_line_moment on trail_line (moment)`
]

const FIELDS = `seq, moment, actor, action, resource, outcome, correlation,
  prev, digest`

export interface Trail {
  readonly append: (entry: Entry) => Effect.Effect<Line, Failure>
  readonly lines: Effect.Effect<ReadonlyArray<Line>, Failure>
  readonly held: Effect.Effect<Held, Failure>
  readonly seal: (key: string) => Effect.Effect<Seal, Failure>
  readonly purge: (
    key: string,
    retentionMs: number
  ) => Effect.Effect<number, Failure>
  readonly verify: (key: string) => Effect.Effect<Report, Failure>
  readonly dump: Effect.Effect<string, Failure>
}

interface Wired extends Trail {
  readonly migrate: Effect.Effect<void, Failure>
}

const asFailure = (): Failure => new Unavailable({ dependency: "audit trail" })

const tally = (value: unknown): number => Number(value ?? 0)

const lineOf = (row: Record<string, unknown>): Line => ({
  seq: tally(row["seq"]),
  at: tally(row["moment"]),
  actor: String(row["actor"]),
  action: String(row["action"]),
  resource: String(row["resource"]),
  outcome: String(row["outcome"]) as Outcome,
  correlation: String(row["correlation"]),
  prev: String(row["prev"]),
  digest: String(row["digest"])
})

const sealRow = (row: Record<string, unknown>): Seal => ({
  seq: tally(row["seq"]),
  digest: String(row["digest"]),
  at: tally(row["moment"]),
  mac: String(row["mac"])
})

const anchorRow = (row: Record<string, unknown>): Anchor => ({
  seq: tally(row["seq"]),
  prev: String(row["prev"]),
  through: tally(row["through"]),
  mac: String(row["mac"])
})

const make = (connection: DuckDBConnection): Wired => {
  const ask = (sql: string, values: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: async () => {
        const reader = await connection.runAndReadAll(sql, [...values] as never)
        return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
      },
      catch: asFailure
    })

  const migrate = Effect.forEach(STATEMENTS, (sql) => ask(sql), {
    discard: true
  })

  const lines = ask(`select ${FIELDS} from trail_line order by seq`).pipe(
    Effect.map((found) => found.map(lineOf))
  )

  const seals = ask(
    `select seq, digest, moment, mac from trail_seal order by seq`
  ).pipe(Effect.map((found) => found.map(sealRow)))

  const anchor = ask(
    `select seq, prev, through, mac from trail_anchor
     order by through desc limit 1`
  ).pipe(
    Effect.map((found) => {
      const row = found[0]
      return row === undefined ? undefined : anchorRow(row)
    })
  )

  const top = ask(
    `select ${FIELDS} from trail_line order by seq desc limit 1`
  ).pipe(
    Effect.map((found) => {
      const row = found[0]
      return row === undefined ? undefined : lineOf(row)
    })
  )

  const start = (
    head: Line | undefined,
    kept: Anchor | undefined
  ): { readonly seq: number; readonly prev: string } => {
    if (head !== undefined) return { seq: head.seq + 1, prev: head.digest }
    if (kept !== undefined) return { seq: kept.seq, prev: kept.prev }
    return { seq: 1, prev: GENESIS }
  }

  const append = (entry: Entry) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const from = start(yield* top, yield* anchor)
      const line: Line = {
        ...entry,
        seq: from.seq,
        at,
        prev: from.prev,
        digest: digestOf(entry, at, from.prev)
      }
      yield* ask(
        `insert into trail_line values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          line.seq,
          line.at,
          line.actor,
          line.action,
          line.resource,
          line.outcome,
          line.correlation,
          line.prev,
          line.digest
        ]
      )
      return line
    })

  const held = Effect.all({ lines, anchor, seals })

  const seal = (key: string) =>
    Effect.gen(function* () {
      const head = yield* top
      if (head === undefined) {
        return yield* Effect.fail(
          new Rejected({ reason: "an empty trail has no head to seal" })
        )
      }
      const at = yield* Clock.currentTimeMillis
      const made = sealOf(key, head.seq, head.digest, at)
      yield* ask(
        `insert or replace into trail_seal values (?, ?, ?, ?)`,
        [made.seq, made.digest, made.at, made.mac]
      )
      return made
    })

  const purge = (key: string, retentionMs: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cutoff = now - retentionMs
      const stale = yield* ask(
        `select ${FIELDS} from trail_line where moment < ?
         order by seq desc limit 1`,
        [cutoff]
      )
      const last = stale[0]
      if (last === undefined) return 0
      const gone = lineOf(last)
      const removed = yield* ask(
        `delete from trail_line where seq <= ? returning seq`,
        [gone.seq]
      )
      const first = yield* ask(
        `select ${FIELDS} from trail_line order by seq limit 1`
      )
      const row = first[0]
      const next = row === undefined ? undefined : lineOf(row)
      const made = anchorOf(
        key,
        next === undefined ? gone.seq + 1 : next.seq,
        next === undefined ? gone.digest : next.prev,
        gone.seq
      )
      yield* ask(`delete from trail_anchor`)
      yield* ask(`insert into trail_anchor values (?, ?, ?, ?)`, [
        made.seq,
        made.prev,
        made.through,
        made.mac
      ])
      yield* ask(`delete from trail_seal where seq <= ?`, [gone.seq])
      return removed.length
    })

  const verify = (key: string) => Effect.map(held, (all) => audit(key, all))

  const dump = Effect.map(held, write)

  return { append, lines, held, seal, purge, verify, dump, migrate }
}

export const trailOn = (
  connection: DuckDBConnection
): Effect.Effect<Trail, Failure> => {
  const trail = make(connection)
  return Effect.as(trail.migrate, trail)
}

export const open = (
  path: string
): Effect.Effect<Trail, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: asFailure
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(Effect.flatMap(trailOn))
