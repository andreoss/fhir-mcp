import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { digest } from "./digest.js"
import { Unauthorized } from "./failure.js"
import type { Denial } from "./failure.js"
import { Clock } from "./ports.js"

export interface Upstream {
  readonly token: string
  readonly subject: string
  readonly expires: number
}

export interface Issued {
  readonly token: string
  readonly subject: string
  readonly expires: number
}

export interface Bound {
  readonly subject: string
  readonly expires: number
}

interface Mapping {
  readonly upstream: Upstream
  readonly expires: number
}

export interface Ledger {
  readonly kept: Map<string, Mapping>
}

export const ledger = (): Ledger => ({ kept: new Map() })

export const held = (ledger: Ledger): ReadonlyArray<string> => [...ledger.kept.keys()]

const refuse = (reason: string) => Effect.fail(new Unauthorized({ reason }))

export const issue = (
  ledger: Ledger,
  upstream: Upstream,
  ttl: number
): Effect.Effect<Issued, Denial, Clock> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const now = clock.seconds()
    if (upstream.expires <= now) {
      return yield* refuse("the upstream grant has expired")
    }
    const token = randomBytes(32).toString("base64url")
    const expires = now + ttl
    ledger.kept.set(digest(token), { upstream, expires })
    return { token, subject: upstream.subject, expires }
  })

const validated = (ledger: Ledger, token: string): Effect.Effect<Mapping, Denial, Clock> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const now = clock.seconds()
    const found = ledger.kept.get(digest(token))
    if (found === undefined) {
      return yield* refuse("the token is mapped to no grant")
    }
    if (found.expires < now) {
      return yield* refuse("the issued token has expired")
    }
    if (found.upstream.expires <= now) {
      return yield* refuse("the upstream grant has expired")
    }
    return found
  })

export const redeem = (ledger: Ledger, token: string): Effect.Effect<Bound, Denial, Clock> =>
  validated(ledger, token).pipe(
    Effect.map((mapping) => ({ subject: mapping.upstream.subject, expires: mapping.expires }))
  )

export const upstream = (ledger: Ledger, token: string): Effect.Effect<string, Denial, Clock> =>
  validated(ledger, token).pipe(Effect.map((mapping) => mapping.upstream.token))

export const revoke = (ledger: Ledger, token: string): void => {
  ledger.kept.delete(digest(token))
}
