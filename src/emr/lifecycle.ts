import { Effect } from "effect"
import { TokenClock, TokenNet, exchange } from "./token.js"
import type { AssertionSigner, Held, IssuerConfig, TokenFailure } from "./token.js"

export interface Lifecycle {
  readonly obtain: () => Effect.Effect<string, TokenFailure, TokenClock | TokenNet>
  readonly refresh: () => Effect.Effect<string, TokenFailure, TokenClock | TokenNet>
  readonly token: () => Effect.Effect<string, TokenFailure, TokenClock | TokenNet>
  readonly invalidate: () => Effect.Effect<void, never>
}

export const lifecycle = (cfg: IssuerConfig, signer: AssertionSigner, held: Held): Lifecycle => {
  const asString = exchange(cfg, signer, held, true).pipe(Effect.map((t) => t.accessToken))

  return {
    obtain: () => asString,
    refresh: () => asString,
    invalidate: () => Effect.sync(() => held.invalidate()),
    token: () => exchange(cfg, signer, held).pipe(Effect.map((t) => t.accessToken))
  }
}