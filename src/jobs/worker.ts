import { randomUUID } from "node:crypto"
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Option,
  Ref
} from "effect"
import { toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { resume } from "../obs/correlation.js"
import { ceilings, limiter } from "./limits.js"
import type { Ceiling } from "./limits.js"
import type { Durable } from "./queue.js"
import { handlerOf, kindsOf } from "./types.js"
import type { Registry, Unit } from "./types.js"

export const workerName = (): string => `worker-${randomUUID()}`

export interface Shift {
  readonly slots: number
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly idleMs: number
  readonly retryInMs: number
  readonly graceMs: number
  readonly ceilings: Readonly<Record<string, Ceiling>>
}

export const SHIFT: Shift = {
  slots: 2,
  leaseMs: 60_000,
  heartbeatMs: 5_000,
  idleMs: 1_000,
  retryInMs: 15_000,
  graceMs: 20_000,
  ceilings: {}
}

export interface Tally {
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  readonly handedOver: number
  readonly lost: number
  readonly faults: number
}

const NOTHING: Tally = {
  completed: 0,
  failed: 0,
  cancelled: 0,
  handedOver: 0,
  lost: 0,
  faults: 0
}

export interface Worker {
  readonly name: string
  readonly report: Effect.Effect<Tally>
  readonly stop: Effect.Effect<Tally>
}

const reasonOf = (cause: Cause.Cause<Failure>): string =>
  Option.match(Cause.failureOption(cause), {
    onNone: () => "unit died",
    onSome: (failure) =>
      toOutcome(failure).issue[0]?.diagnostics ?? "unit failed"
  })

export const start = (
  queue: Durable,
  registry: Registry,
  given: Partial<Shift> = {}
): Effect.Effect<Worker> =>
  Effect.gen(function* () {
    const shift: Shift = { ...SHIFT, ...given }
    const name = workerName()
    const kinds = kindsOf(registry)
    const gates = yield* limiter(ceilings(kinds, shift.ceilings))
    const halting = yield* Deferred.make<void>()
    const counts = yield* Ref.make<Tally>(NOTHING)

    const bump = (key: keyof Tally) =>
      Ref.update(counts, (held): Tally => ({ ...held, [key]: held[key] + 1 }))

    const guard = (unit: Unit) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(shift.heartbeatMs))
          const beat = yield* queue.beat(unit, shift.leaseMs)
          if (!beat.held) return "lost" as const
          if (beat.cancelling) return "cancelling" as const
        }
      }).pipe(Effect.orElseSucceed(() => "lost" as const))

    const perform = (unit: Unit) =>
      Effect.gen(function* () {
        const handler = yield* handlerOf(registry, unit.kind)
        const work = gates.gate(
          unit.kind,
          resume({ correlation: unit.correlation }, handler.run(unit))
        )
        return yield* Effect.raceFirst(
          Effect.as(work, "done" as const),
          guard(unit)
        )
      })

    const settled = (unit: Unit, outcome: "done" | "cancelling" | "lost") => {
      if (outcome === "done") {
        return Effect.zipRight(queue.complete(unit), bump("completed"))
      }
      if (outcome === "cancelling") {
        return Effect.zipRight(queue.abandon(unit), bump("cancelled"))
      }
      return bump("lost")
    }

    const handover = (unit: Unit) =>
      queue.release(unit).pipe(
        Effect.flatMap((given) =>
          given ? bump("handedOver") : Effect.void
        ),
        Effect.ignore
      )

    const process = (unit: Unit) =>
      perform(unit).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause: Cause.Cause<Failure>) =>
            Cause.isInterrupted(cause)
              ? Effect.failCause(cause)
              : Effect.zipRight(
                  queue.fail(unit, reasonOf(cause), shift.retryInMs),
                  bump("failed")
                ),
          onSuccess: (outcome) => settled(unit, outcome)
        }),
        Effect.onExit((exit) =>
          Exit.isInterrupted(exit) ? handover(unit) : Effect.void
        )
      )

    const idle = Effect.raceFirst(
      Effect.sleep(Duration.millis(shift.idleMs)),
      Deferred.await(halting)
    )

    const slot = Effect.gen(function* () {
      while (!(yield* Deferred.isDone(halting))) {
        const taken = yield* Effect.either(
          queue.lease(name, kinds, shift.leaseMs)
        )
        if (Either.isLeft(taken)) {
          yield* bump("faults")
          yield* idle
          continue
        }
        const unit = taken.right
        if (unit === undefined) {
          yield* idle
          continue
        }
        yield* Effect.catchAll(process(unit), () => bump("faults"))
      }
    })

    const slots = yield* Effect.forEach(
      Array.from({ length: Math.max(1, shift.slots) }, (_, index) => index),
      () => Effect.forkDaemon(slot)
    )

    const stop = Effect.gen(function* () {
      yield* Deferred.succeed(halting, void 0)
      yield* Effect.ignore(
        Effect.timeout(
          Fiber.awaitAll(slots),
          Duration.millis(shift.graceMs)
        )
      )
      yield* Fiber.interruptAll(slots)
      return yield* Ref.get(counts)
    })

    return { name, report: Ref.get(counts), stop }
  })
