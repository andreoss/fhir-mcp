import { Context, Effect, Option } from "effect"
import { randomUUID } from "node:crypto"

export interface Correlation {
  readonly id: string
}

export class Correlated extends Context.Tag("Correlated")<Correlated, Correlation>() {}

export interface Handoff {
  readonly correlation: string
}

export const NONE = "none"

const bounded = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const mint = (): string => randomUUID()

export const accept = (given: string | undefined): string =>
  given !== undefined && bounded.test(given) ? given : mint()

export const id: Effect.Effect<string, never, Correlated> = Effect.map(
  Correlated,
  (held) => held.id
)

export const known: Effect.Effect<string> = Effect.map(
  Effect.serviceOption(Correlated),
  Option.match({ onNone: () => NONE, onSome: (held) => held.id })
)

export const edge = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  given?: string
): Effect.Effect<A, E, Exclude<R, Correlated>> =>
  Effect.provideServiceEffect(effect, Correlated, Effect.sync(() => ({ id: accept(given) })))

export const handoff: Effect.Effect<Handoff, never, Correlated> = Effect.map(
  Correlated,
  (held) => ({ correlation: held.id })
)

export const resume = <A, E, R>(
  token: Handoff,
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Correlated>> =>
  Effect.provideService(work, Correlated, { id: accept(token.correlation) })
