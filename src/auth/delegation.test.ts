import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Denial } from "./failure.js"
import { status } from "./failure.js"
import { held, issue, ledger, redeem, revoke, upstream } from "./delegation.js"
import type { Ledger, Upstream } from "./delegation.js"
import { clockAt } from "./ports.js"
import type { Clock } from "./ports.js"

const NOW = 1_800_000_000
const UPSTREAM = "third-party-access-token-value"

const source: Upstream = { token: UPSTREAM, subject: "practitioner-7", expires: NOW + 600 }

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

const bound = (kept: Ledger, ttl = 300, seconds = NOW) => value(at(seconds, issue(kept, source, ttl)))

describe("third party delegation, MCPA-04", () => {
  it("issues a token of its own that is not the upstream one", () => {
    const issued = bound(ledger())
    expect(issued.token).not.toBe(UPSTREAM)
    expect(issued.subject).toBe("practitioner-7")
    expect(Buffer.from(issued.token, "base64url")).toHaveLength(32)
  })

  it("never hands the upstream token to the client", () => {
    const kept = ledger()
    const issued = bound(kept)
    expect(JSON.stringify(issued)).not.toContain(UPSTREAM)
    expect(JSON.stringify(value(at(NOW, redeem(kept, issued.token))))).not.toContain(UPSTREAM)
    expect(held(kept).join(",")).not.toContain(UPSTREAM)
    expect(held(kept).join(",")).not.toContain(issued.token)
  })

  it("validates the mapping on every call", () => {
    const kept = ledger()
    const issued = bound(kept)
    expect(value(at(NOW, redeem(kept, issued.token))).subject).toBe("practitioner-7")
    expect(value(at(NOW + 10, redeem(kept, issued.token))).subject).toBe("practitioner-7")
    revoke(kept, issued.token)
    expect(status(denial(at(NOW + 20, redeem(kept, issued.token))))).toBe(401)
  })

  it("refuses a token that was never mapped", () => {
    expect(status(denial(at(NOW, redeem(ledger(), "invented-token"))))).toBe(401)
  })

  it("invalidates the issued token when the upstream one expires", () => {
    const kept = ledger()
    const issued = value(at(NOW, issue(kept, { ...source, expires: NOW + 60 }, 3600)))
    expect(issued.expires).toBe(NOW + 3600)
    expect(Exit.isSuccess(at(NOW + 30, redeem(kept, issued.token)))).toBe(true)
    const refusal = denial(at(NOW + 61, redeem(kept, issued.token)))
    expect(status(refusal)).toBe(401)
    expect(refusal._tag).toBe("Unauthorized")
  })

  it("refuses to issue against an upstream token that has already expired", () => {
    expect(status(denial(at(NOW, issue(ledger(), { ...source, expires: NOW - 1 }, 300))))).toBe(401)
  })

  it("expires on its own schedule when that ends first", () => {
    const kept = ledger()
    const issued = bound(kept, 60)
    expect(issued.expires).toBe(NOW + 60)
    expect(status(denial(at(NOW + 61, redeem(kept, issued.token))))).toBe(401)
  })

  it("hands the upstream token to the server only after the mapping holds", () => {
    const kept = ledger()
    const issued = bound(kept)
    expect(value(at(NOW, upstream(kept, issued.token)))).toBe(UPSTREAM)
    expect(status(denial(at(NOW + 301, upstream(kept, issued.token))))).toBe(401)
    expect(status(denial(at(NOW, upstream(kept, "invented-token"))))).toBe(401)
  })
})
