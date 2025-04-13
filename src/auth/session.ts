import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { digest, same } from "./digest.js"
import { Unauthorized } from "./failure.js"
import type { Denial } from "./failure.js"
import { Clock } from "./ports.js"

export interface Session {
  readonly id: string
  readonly subject: string
  readonly expires: number
}

interface Kept {
  readonly subject: string
  readonly expires: number
}

export interface Book {
  readonly kept: Map<string, Kept>
}

export const book = (): Book => ({ kept: new Map() })

export const held = (book: Book): ReadonlyArray<string> => [...book.kept.keys()]

const refuse = (reason: string) => Effect.fail(new Unauthorized({ reason }))

export const open = (
  book: Book,
  subject: string,
  ttl: number
): Effect.Effect<Session, never, Clock> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const id = randomBytes(32).toString("base64url")
    const expires = clock.seconds() + ttl
    book.kept.set(digest(id), { subject, expires })
    return { id, subject, expires }
  })

export const use = (
  book: Book,
  id: string,
  subject: string
): Effect.Effect<Session, Denial, Clock> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const key = digest(id)
    const found = book.kept.get(key)
    if (found === undefined) {
      return yield* refuse("the session is not recognised")
    }
    if (found.expires < clock.seconds()) {
      book.kept.delete(key)
      return yield* refuse("the session has expired")
    }
    if (!same(found.subject, subject)) {
      return yield* refuse("the session is bound to another subject")
    }
    return { id, subject: found.subject, expires: found.expires }
  })

export const close = (book: Book, id: string): void => {
  book.kept.delete(digest(id))
}

export const sweep = (book: Book): Effect.Effect<number, never, Clock> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const now = clock.seconds()
    let dropped = 0
    for (const [key, session] of book.kept) {
      if (session.expires < now) {
        book.kept.delete(key)
        dropped += 1
      }
    }
    return dropped
  })
