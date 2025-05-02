import { randomUUID } from "node:crypto"
import { Clock, Effect } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Conflict, NotFound, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Beat, Job, JobState, Retry, Unit, UnitState } from "./types.js"

export const STATEMENTS: ReadonlyArray<string> = [
  `create table if not exists job (
     job_id varchar primary key,
     kind varchar not null,
     cancel boolean not null,
     submitted_at bigint not null,
     updated_at bigint not null,
     correlation varchar not null
   )`,
  `create table if not exists job_unit (
     unit_id varchar primary key,
     job_id varchar not null,
     kind varchar not null,
     correlation varchar not null,
     state varchar not null,
     attempts integer not null,
     max_attempts integer not null,
     worker varchar,
     lease varchar,
     lease_until bigint not null,
     updated_at bigint not null,
     payload varchar not null,
     detail varchar
   )`,
  `create index if not exists job_unit_ready
     on job_unit (kind, state, lease_until)`,
  `create index if not exists job_unit_owner on job_unit (job_id, state)`
]

export const BATCH = 500

const COLUMNS = 13

const PENDING = `sum(case when u.state in ('ready','leased') then 1 else 0 end)`

const POLL = `select j.kind, j.cancel, j.submitted_at, j.correlation,
    count(u.unit_id) as total,
    coalesce(sum(case when u.state = 'done' then 1 else 0 end), 0) as done,
    coalesce(sum(case when u.state = 'failed' then 1 else 0 end), 0) as failed,
    coalesce(sum(case when u.state = 'cancelled' then 1 else 0 end), 0)
      as cancelled,
    coalesce(${PENDING}, 0) as pending,
    coalesce(sum(u.attempts), 0) as attempted,
    coalesce(max(u.updated_at), j.updated_at) as updated,
    min(case when u.state = 'failed' then u.detail end) as detail
  from job j left join job_unit u on u.job_id = j.job_id
  where j.job_id = ?
  group by j.job_id, j.kind, j.cancel, j.submitted_at, j.correlation,
    j.updated_at`

const RIPE = `select j.job_id from job j left join job_unit u
    on u.job_id = j.job_id
  group by j.job_id, j.updated_at
  having coalesce(${PENDING}, 0) = 0
     and coalesce(max(u.updated_at), j.updated_at) <= ?
  limit ${BATCH}`

const RECLAIM = `update job_unit set
    state = case
      when (select j.cancel from job j where j.job_id = job_unit.job_id)
        then 'cancelled'
      when attempts < max_attempts then 'ready'
      else 'failed' end,
    detail = case
      when (select j.cancel from job j where j.job_id = job_unit.job_id)
        then detail
      when attempts < max_attempts then detail
      else 'lease lost' end,
    worker = null, lease = null, lease_until = 0, updated_at = ?
  where state = 'leased' and lease_until <= ?
  returning unit_id`

const claiming = (kinds: ReadonlyArray<string>): string => {
  const holes = kinds.map(() => "?").join(",")
  return `update job_unit set state = 'leased', worker = ?, lease = ?,
      lease_until = ?, attempts = attempts + 1, updated_at = ?
    where unit_id = (
      select u.unit_id from job_unit u join job j on j.job_id = u.job_id
      where u.kind in (${holes}) and u.state in ('ready','leased')
        and u.lease_until <= ? and not j.cancel
      order by u.updated_at, u.unit_id limit 1)
    returning unit_id, job_id, kind, correlation, attempts, payload, lease`
}

export interface Submission {
  readonly kind: string
  readonly payloads: ReadonlyArray<string>
  readonly correlation: string
  readonly maxAttempts: number
}

export interface Held {
  readonly unitId: string
  readonly state: UnitState
  readonly attempts: number
  readonly worker: string | undefined
  readonly leaseUntil: number
  readonly updatedAt: number
  readonly payload: string
  readonly detail: string | undefined
}

export interface Durable {
  readonly submit: (input: Submission) => Effect.Effect<string, Failure>
  readonly poll: (jobId: string) => Effect.Effect<Job, Failure>
  readonly cancel: (jobId: string) => Effect.Effect<void, Failure>
  readonly lease: (
    worker: string,
    kinds: ReadonlyArray<string>,
    leaseMs: number
  ) => Effect.Effect<Unit | undefined, Failure>
  readonly beat: (unit: Unit, leaseMs: number) => Effect.Effect<Beat, Failure>
  readonly complete: (unit: Unit) => Effect.Effect<boolean, Failure>
  readonly abandon: (unit: Unit) => Effect.Effect<boolean, Failure>
  readonly release: (unit: Unit) => Effect.Effect<boolean, Failure>
  readonly fail: (
    unit: Unit,
    detail: string,
    retryInMs: number
  ) => Effect.Effect<Retry, Failure>
  readonly reclaim: () => Effect.Effect<number, Failure>
  readonly purge: (retentionMs: number) => Effect.Effect<number, Failure>
  readonly defrag: () => Effect.Effect<number, Failure>
  readonly inspect: (
    jobId: string
  ) => Effect.Effect<ReadonlyArray<Held>, Failure>
}

const asFailure = (): Failure => new Unavailable({ dependency: "job queue" })

const tally = (value: unknown): number => Number(value ?? 0)

const words = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value)

const stateOf = (row: Record<string, unknown>): JobState => {
  if (tally(row["pending"]) > 0) {
    return tally(row["attempted"]) > 0 ? "running" : "queued"
  }
  if (tally(row["failed"]) > 0) return "failed"
  if (tally(row["cancelled"]) > 0) return "cancelled"
  return "done"
}

const jobOf = (id: string, row: Record<string, unknown>): Job => ({
  id,
  kind: String(row["kind"]),
  state: stateOf(row),
  cancelling: row["cancel"] === true,
  total: tally(row["total"]),
  pending: tally(row["pending"]),
  done: tally(row["done"]),
  failed: tally(row["failed"]),
  cancelled: tally(row["cancelled"]),
  submitted: tally(row["submitted_at"]),
  updated: tally(row["updated"]),
  correlation: String(row["correlation"]),
  detail: words(row["detail"])
})

const unitOf = (row: Record<string, unknown>): Unit => ({
  unitId: String(row["unit_id"]),
  jobId: String(row["job_id"]),
  kind: String(row["kind"]),
  correlation: String(row["correlation"]),
  attempts: tally(row["attempts"]),
  payload: String(row["payload"]),
  lease: String(row["lease"])
})

const heldOf = (row: Record<string, unknown>): Held => ({
  unitId: String(row["unit_id"]),
  state: String(row["state"]) as UnitState,
  attempts: tally(row["attempts"]),
  worker: words(row["worker"]),
  leaseUntil: tally(row["lease_until"]),
  updatedAt: tally(row["updated_at"]),
  payload: String(row["payload"]),
  detail: words(row["detail"])
})

const make = (connection: DuckDBConnection): Durable & {
  readonly migrate: Effect.Effect<void, Failure>
} => {
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

  const submit = (input: Submission) =>
    Effect.gen(function* () {
      if (input.payloads.length === 0) {
        return yield* Effect.fail(
          new Rejected({ reason: "a job splits into no unit of work" })
        )
      }
      if (input.maxAttempts < 1) {
        return yield* Effect.fail(
          new Rejected({ reason: "a job needs at least one attempt" })
        )
      }
      const at = yield* Clock.currentTimeMillis
      const jobId = randomUUID()
      const values = input.payloads.flatMap((payload) => [
        randomUUID(),
        jobId,
        input.kind,
        input.correlation,
        "ready",
        0,
        input.maxAttempts,
        null,
        null,
        0,
        at,
        payload,
        null
      ])
      const holes = input.payloads
        .map(() => `(${new Array(COLUMNS).fill("?").join(",")})`)
        .join(",")
      yield* ask(`insert into job_unit values ${holes}`, values)
      yield* ask(
        `insert into job
           (job_id, kind, cancel, submitted_at, updated_at, correlation)
         values (?, ?, false, ?, ?, ?)`,
        [jobId, input.kind, at, at, input.correlation]
      )
      return jobId
    })

  const poll = (jobId: string) =>
    ask(POLL, [jobId]).pipe(
      Effect.flatMap((found) => {
        const row = found[0]
        return row === undefined
          ? Effect.fail(new NotFound({ type: "job", id: jobId }))
          : Effect.succeed(jobOf(jobId, row))
      })
    )

  const cancel = (jobId: string) =>
    Effect.gen(function* () {
      const job = yield* poll(jobId)
      if (job.pending === 0 && !job.cancelling) {
        return yield* Effect.fail(
          new Conflict({ reason: `job ${jobId} already finished` })
        )
      }
      const at = yield* Clock.currentTimeMillis
      yield* ask(`update job set cancel = true, updated_at = ? where job_id = ?`, [
        at,
        jobId
      ])
      yield* ask(
        `update job_unit set state = 'cancelled', updated_at = ?
         where job_id = ? and state = 'ready'`,
        [at, jobId]
      )
    })

  const lease = (
    worker: string,
    kinds: ReadonlyArray<string>,
    leaseMs: number
  ) =>
    Effect.gen(function* () {
      if (kinds.length === 0) return undefined
      const at = yield* Clock.currentTimeMillis
      const found = yield* ask(claiming(kinds), [
        worker,
        randomUUID(),
        at + leaseMs,
        at,
        ...kinds,
        at
      ])
      const row = found[0]
      return row === undefined ? undefined : unitOf(row)
    })

  const beat = (unit: Unit, leaseMs: number) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const held = yield* ask(
        `update job_unit set lease_until = ?, updated_at = ?
         where unit_id = ? and lease = ? and state = 'leased'
         returning unit_id`,
        [at + leaseMs, at, unit.unitId, unit.lease]
      )
      if (held.length === 0) return { held: false, cancelling: false }
      const job = yield* ask(`select cancel from job where job_id = ?`, [
        unit.jobId
      ])
      return { held: true, cancelling: job[0]?.["cancel"] === true }
    })

  const settle = (unit: Unit, state: UnitState) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const done = yield* ask(
        `update job_unit set state = ?, lease = null, lease_until = 0,
           updated_at = ?
         where unit_id = ? and lease = ? and state = 'leased'
         returning unit_id`,
        [state, at, unit.unitId, unit.lease]
      )
      return done.length > 0
    })

  const release = (unit: Unit) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const back = yield* ask(
        `update job_unit set state = 'ready', worker = null, lease = null,
           lease_until = 0, updated_at = ?,
           attempts = case when attempts > 0 then attempts - 1 else 0 end
         where unit_id = ? and lease = ? and state = 'leased'
         returning unit_id`,
        [at, unit.unitId, unit.lease]
      )
      return back.length > 0
    })

  const fail = (unit: Unit, detail: string, retryInMs: number) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const done = yield* ask(
        `update job_unit set
           state = case when attempts < max_attempts then 'ready'
             else 'failed' end,
           lease = null, detail = ?, updated_at = ?,
           lease_until = case when attempts < max_attempts then ? else 0 end
         where unit_id = ? and lease = ? and state = 'leased'
         returning state`,
        [detail, at, at + retryInMs, unit.unitId, unit.lease]
      )
      const retried = done[0]?.["state"] === "ready"
      return { retried, retryInMs: retried ? retryInMs : 0 }
    })

  const reclaim = () =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const taken = yield* ask(RECLAIM, [at, at])
      return taken.length
    })

  const purge = (retentionMs: number) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const ripe = yield* ask(RIPE, [at - retentionMs])
      const ids = ripe.map((row) => String(row["job_id"]))
      if (ids.length === 0) return 0
      const holes = ids.map(() => "?").join(",")
      yield* ask(`delete from job_unit where job_id in (${holes})`, ids)
      yield* ask(`delete from job where job_id in (${holes})`, ids)
      return ids.length
    })

  const defrag = () =>
    Effect.gen(function* () {
      const orphans = yield* ask(
        `delete from job_unit
         where job_id not in (select job_id from job)
         returning unit_id`
      )
      const compacted = yield* ask(
        `update job_unit set payload = ''
         where state in ('done','failed','cancelled') and payload <> ''
         returning unit_id`
      )
      yield* ask(`checkpoint`)
      return orphans.length + compacted.length
    })

  const inspect = (jobId: string) =>
    ask(
      `select unit_id, state, attempts, worker, lease_until, updated_at,
         payload, detail
       from job_unit where job_id = ? order by unit_id`,
      [jobId]
    ).pipe(Effect.map((found) => found.map(heldOf)))

  return {
    submit,
    poll,
    cancel,
    lease,
    beat,
    complete: (unit: Unit) => settle(unit, "done"),
    abandon: (unit: Unit) => settle(unit, "cancelled"),
    release,
    fail,
    reclaim,
    purge,
    defrag,
    inspect,
    migrate
  }
}

export const queueOn = (
  connection: DuckDBConnection
): Effect.Effect<Durable, Failure> => {
  const queue = make(connection)
  return Effect.as(queue.migrate, queue)
}

export const open = (
  path: string
): Effect.Effect<Durable, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        return await instance.connect()
      },
      catch: asFailure
    }),
    (connection) => Effect.sync(() => connection.closeSync())
  ).pipe(Effect.flatMap(queueOn))
