import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { credentialsOf } from "../host/wiring.js"
import { TokenClock, TokenNet } from "./token.js"
import type { BackendConfig } from "./backend.js"
import type { Answer } from "./wire.js"

const NOW_MS = 1_700_000_000_000

const smart = (over: Partial<BackendConfig> = {}): BackendConfig => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return {
    name: "clinic-a",
    baseUrl: "https://emr.example/fhir",
    provider: "smart",
    timeoutMs: 30000,
    retryAfterMs: 500,
    auth: {
      scheme: "smart",
      tokenUrl: "https://auth.example/token",
      clientId: "client-1",
      kid: "key-1",
      key: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      assertionLifetimeMs: 300000,
      refreshMarginMs: 10000
    },
    ...over
  }
}

const issued = (access: string): Answer => ({
  status: 200,
  url: "https://auth.example/token",
  headers: {},
  body: JSON.stringify({ access_token: access, token_type: "Bearer", expires_in: 3600 })
})

const netOf = (grant: () => string) => {
  const seen: Array<{ url: string; body: string }> = []
  const post = (url: string, body: string) => {
    seen.push({ url, body })
    return Effect.succeed(issued(grant()))
  }
  return { post, seen }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, TokenClock | TokenNet>,
  clockMs: number,
  net: { post: (url: string, body: string) => Effect.Effect<Answer, never> }
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(TokenClock as never, { ms: () => clockMs }),
      Effect.provideService(TokenNet as never, net)
    )
  ) as Promise<A>

describe("outbound credential lifecycle", () => {
  it("obtains and refreshes the grant from the composition wiring", async () => {
    const grant = [() => "tok-1", () => "tok-2", () => "tok-3"]
    let step = 0
    const net = netOf(() => grant[Math.min(step, grant.length - 1)]?.() ?? "tok-x")
    const lf = credentialsOf(smart())
    const first = await run(lf.obtain(), NOW_MS, net)
    step = 1
    const refreshed = await run(lf.refresh(), NOW_MS + 60_000, net)
    expect(first).toBe("tok-1")
    expect(refreshed).toBe("tok-2")
    expect(net.seen.length).toBe(2)
  })

  it("reuses the grant within its life and turns over at the margin", async () => {
    const grant = ["tok-1", "tok-2"]
    let step = 0
    const net = netOf(() => grant[Math.min(step, grant.length - 1)] ?? "tok-x")
    const lf = credentialsOf(smart())
    await run(lf.obtain(), NOW_MS, net)
    expect(await run(lf.token(), NOW_MS + 300_000, net)).toBe("tok-1")
    step = 1
    expect(await run(lf.token(), NOW_MS + 3590_000, net)).toBe("tok-2")
    expect(net.seen.length).toBe(2)
  })

  it("invalidates the held grant and exchanges again on the next call", async () => {
    const grant = ["tok-1", "tok-2"]
    let step = 0
    const net = netOf(() => grant[Math.min(step, grant.length - 1)] ?? "tok-x")
    const lf = credentialsOf(smart())
    await run(lf.obtain(), NOW_MS, net)
    step = 1
    await Effect.runPromise(lf.invalidate())
    expect(await run(lf.token(), NOW_MS + 60_000, net)).toBe("tok-2")
    expect(net.seen.length).toBe(2)
  })

  it("refuses a backend without an issuer", () => {
    expect(() => credentialsOf({} as BackendConfig)).toThrow(/no issuer/)
  })
})