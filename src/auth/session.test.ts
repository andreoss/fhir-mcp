import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Denial } from "./failure.js"
import { status } from "./failure.js"
import { clockAt } from "./ports.js"
import type { Clock } from "./ports.js"
import { book, close, held, open, sweep, use } from "./session.js"
import type { Book } from "./session.js"

const NOW = 1_800_000_000
const TTL = 900

const at = <A>(seconds: number, effect: Effect.Effect<A, Denial, Clock>) =>
  Effect.runSyncExit(Effect.provide(effect, clockAt(seconds)))

const value = <A>(exit: Exit.Exit<A, Denial>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a value, got ${JSON.stringify(exit)}`)
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

const opened = (kept: Book, subject = "practitioner-7", seconds = NOW) =>
  value(at(seconds, open(kept, subject, TTL)))

describe("session identifier, MCPA-06", () => {
  it("is random and wide", () => {
    const kept = book()
    const one = opened(kept)
    const other = opened(kept)
    expect(one.id).not.toBe(other.id)
    expect(Buffer.from(one.id, "base64url")).toHaveLength(32)
  })

  it("expires on the schedule it was opened with", () => {
    const kept = book()
    expect(opened(kept).expires).toBe(NOW + TTL)
  })

  it("is never kept in the clear", () => {
    const kept = book()
    const session = opened(kept)
    expect(held(kept)).toHaveLength(1)
    expect(held(kept).join(",")).not.toContain(session.id)
  })
})

describe("session binding, MCPA-06", () => {
  it("resumes for the subject it was bound to", () => {
    const kept = book()
    const session = opened(kept)
    const resumed = value(at(NOW + 10, use(kept, session.id, "practitioner-7")))
    expect(resumed.subject).toBe("practitioner-7")
    expect(resumed.id).toBe(session.id)
  })

  it("is unusable from another subject", () => {
    const kept = book()
    const session = opened(kept)
    const refusal = denial(at(NOW + 10, use(kept, session.id, "practitioner-9")))
    expect(status(refusal)).toBe(401)
    expect(refusal._tag).toBe("Unauthorized")
  })

  it("refuses an identifier that was never opened", () => {
    expect(status(denial(at(NOW, use(book(), "not-a-session", "practitioner-7"))))).toBe(401)
  })

  it("refuses once it has expired and does not keep it", () => {
    const kept = book()
    const session = opened(kept)
    expect(status(denial(at(NOW + TTL + 1, use(kept, session.id, "practitioner-7"))))).toBe(401)
    expect(held(kept)).toHaveLength(0)
  })

  it("holds right up to the moment it expires", () => {
    const kept = book()
    const session = opened(kept)
    expect(Exit.isSuccess(at(NOW + TTL, use(kept, session.id, "practitioner-7")))).toBe(true)
  })

  it("ends when it is closed", () => {
    const kept = book()
    const session = opened(kept)
    close(kept, session.id)
    expect(held(kept)).toHaveLength(0)
    expect(status(denial(at(NOW, use(kept, session.id, "practitioner-7"))))).toBe(401)
  })
})

describe("session sweep, MCPA-06", () => {
  it("drops what has expired and keeps what has not", () => {
    const kept = book()
    opened(kept, "practitioner-7", NOW - TTL - 1)
    const live = opened(kept, "practitioner-8", NOW)
    const dropped = Effect.runSync(Effect.provide(sweep(kept), clockAt(NOW)))
    expect(dropped).toBe(1)
    expect(held(kept)).toHaveLength(1)
    expect(Exit.isSuccess(at(NOW, use(kept, live.id, "practitioner-8")))).toBe(true)
  })
})
