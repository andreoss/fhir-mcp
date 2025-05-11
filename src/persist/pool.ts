import { Deferred, Duration, Effect, Option, Ref } from "effect"
import type { Scope } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export type Kind = "read" | "write"

export interface Budget {
  readonly size: number
  readonly reserved: number
  readonly waitMs: number
  readonly retryAfterMs: number
}

export const BUDGET: Budget = {
  size: 4,
  reserved: 1,
  waitMs: 2_000,
  retryAfterMs: 500
}

export interface Census {
  readonly free: number
  readonly writing: number
  readonly waiting: number
}

export interface Pool<A> {
  readonly use: <B, E, R>(
    kind: Kind,
    work: (item: A) => Effect.Effect<B, E, R>
  ) => Effect.Effect<B, E | Failure, R>
  readonly census: Effect.Effect<Census>
}

const HINT = /\(retry after (\d+)ms\)/

export const stalled = (name: string, retryAfterMs: number): Failure =>
  new Unavailable({ dependency: `${name} (retry after ${retryAfterMs}ms)` })

export const retryAfter = (failure: Failure): number | undefined => {
  if (failure._tag !== "Unavailable") return undefined
  const digits = HINT.exec(failure.dependency)?.[1]
  return digits === undefined ? undefined : Number(digits)
}

interface Waiter<A> {
  readonly at: number
  readonly kind: Kind
  readonly gate: Deferred.Deferred<A>
}

interface State<A> {
  readonly free: ReadonlyArray<A>
  readonly writing: number
  readonly waiting: ReadonlyArray<Waiter<A>>
  readonly next: number
}

type Grant<A> = readonly [Waiter<A>, A]

export const ceilingOf = (budget: Budget): number =>
  Math.max(1, budget.size - Math.max(0, budget.reserved))

const serve = <A>(
  held: State<A>,
  ceiling: number
): readonly [ReadonlyArray<Grant<A>>, State<A>] => {
  const grants: Array<Grant<A>> = []
  const free = [...held.free]
  const queued: Array<Waiter<A>> = []
  let writing = held.writing
  for (const one of held.waiting) {
    const barred = one.kind === "write" && writing >= ceiling
    const item = barred ? undefined : free.shift()
    if (item === undefined) {
      queued.push(one)
      continue
    }
    if (one.kind === "write") writing += 1
    grants.push([one, item])
  }
  return [grants, { free, writing, waiting: queued, next: held.next }]
}

export const pool = <A>(
  items: ReadonlyArray<A>,
  name: string,
  budget: Budget
): Effect.Effect<Pool<A>> =>
  Effect.gen(function* () {
    const ceiling = ceilingOf(budget)
    const state = yield* Ref.make<State<A>>({
      free: [...items],
      writing: 0,
      waiting: [],
      next: 0
    })

    const flush = (grants: ReadonlyArray<Grant<A>>) =>
      Effect.forEach(
        grants,
        ([one, item]) => Deferred.succeed(one.gate, item),
        { discard: true }
      )

    const release = (kind: Kind, item: A): Effect.Effect<void> =>
      Ref.modify(state, (held) =>
        serve(
          {
            ...held,
            free: [...held.free, item],
            writing: kind === "write" ? held.writing - 1 : held.writing
          },
          ceiling
        )
      ).pipe(Effect.flatMap(flush))

    const enter = (kind: Kind, gate: Deferred.Deferred<A>) =>
      Ref.modify(state, (held) => {
        const one: Waiter<A> = { at: held.next, kind, gate }
        const [grants, next] = serve(
          { ...held, waiting: [...held.waiting, one], next: held.next + 1 },
          ceiling
        )
        return [[grants, one.at] as const, next]
      }).pipe(
        Effect.tap(([grants]) => flush(grants)),
        Effect.map(([, at]) => at)
      )

    const unqueue = (at: number): Effect.Effect<boolean> =>
      Ref.modify(state, (held) => {
        const rest = held.waiting.filter((one) => one.at !== at)
        return [rest.length !== held.waiting.length, { ...held, waiting: rest }]
      })

    const forsake = (
      at: number,
      gate: Deferred.Deferred<A>
    ): Effect.Effect<Option.Option<A>> =>
      Effect.flatMap(unqueue(at), (dropped) =>
        dropped ? Effect.succeedNone : Effect.asSome(Deferred.await(gate))
      )

    const acquire = (kind: Kind): Effect.Effect<A, Failure> =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<A>()
        const at = yield* enter(kind, gate)
        if (yield* Deferred.isDone(gate)) return yield* Deferred.await(gate)
        const got = yield* Effect.timeoutOption(
          Deferred.await(gate),
          Duration.millis(budget.waitMs)
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.flatMap(forsake(at, gate), (late) =>
              Option.isSome(late) ? release(kind, late.value) : Effect.void
            )
          )
        )
        if (Option.isSome(got)) return got.value
        const late = yield* forsake(at, gate)
        if (Option.isSome(late)) return late.value
        return yield* Effect.fail(stalled(name, budget.retryAfterMs))
      })

    const use = <B, E, R>(
      kind: Kind,
      work: (item: A) => Effect.Effect<B, E, R>
    ): Effect.Effect<B, E | Failure, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(restore(acquire(kind)), (item) =>
          Effect.onExit(restore(work(item)), () => release(kind, item))
        )
      )

    const census = Effect.map(Ref.get(state), (held) => ({
      free: held.free.length,
      writing: held.writing,
      waiting: held.waiting.length
    }))

    return { use, census }
  })

export const connections = (
  path: string,
  budget: Budget
): Effect.Effect<Pool<DuckDBConnection>, Failure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path)
        const made: Array<DuckDBConnection> = []
        for (let n = 0; n < Math.max(1, budget.size); n++) {
          made.push(await instance.connect())
        }
        return made
      },
      catch: (): Failure => new Unavailable({ dependency: "store" })
    }),
    (made) => Effect.sync(() => made.forEach((one) => one.closeSync()))
  ).pipe(Effect.flatMap((made) => pool(made, "store", budget)))
