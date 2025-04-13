import { Effect } from "effect"
import { Clock } from "./ports.js"
import { verify } from "./verify.js"
import type { Expect } from "./verify.js"

export interface Active {
  readonly active: true
  readonly iss: string
  readonly sub: string
  readonly aud: ReadonlyArray<string>
  readonly exp: number
  readonly scope: string
  readonly client_id?: string
}

export interface Inactive {
  readonly active: false
}

export type Introspection = Active | Inactive

export const introspect = (
  token: string,
  expect: Expect
): Effect.Effect<Introspection, never, Clock> =>
  verify(token, expect).pipe(
    Effect.map((claims): Introspection => ({
      active: true,
      iss: claims.iss,
      sub: claims.sub,
      aud: claims.aud,
      exp: claims.exp,
      scope: claims.scope.join(" "),
      ...(claims.client === undefined ? {} : { client_id: claims.client })
    })),
    Effect.catchAll(() => Effect.succeed<Introspection>({ active: false }))
  )
