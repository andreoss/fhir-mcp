import { Effect } from "effect"
import { Expired, TokenClock, TokenNet, exchange } from "./token.js"
import type { AssertionSigner, Held, IssuerConfig, TokenFailure } from "./token.js"

export interface Lifecycle {
  readonly obtain: () => Effect.Effect<string, TokenFailure, TokenClock | TokenNet>
  readonly refresh: () => Effect.Effect<string, TokenFailure, TokenClock | TokenNet>
  readonly token: () => Effect.Effect<string, TokenFailure, TokenClock | TokenNet>
}

export const lifecycle = (cfg: IssuerConfig, signer: AssertionSigner, held: Held): Lifecycle => {
  const asString = exchange(cfg, signer, held, true).pipe(Effect.map((t) => t.accessToken))

  return {
    obtain: () => asString,
    refresh: () => asString,
    token: () =>
      Effect.gen(function* () {
        const clock = yield* TokenClock
        const grant = held.grant()
        if (grant !== undefined && grant.expiresAt * 1000 <= clock.ms()) {
          return yield* Effect.fail(new Expired({ reason: "the upstream grant has expired" }))
        }
        return yield* exchange(cfg, signer, held)
      }).pipe(Effect.map((t) => t.accessToken))
  }
}