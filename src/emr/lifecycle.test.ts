import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { TokenClock, TokenNet, cache } from "./token.js"
import type { IssuerConfig } from "./token.js"
import { lifecycle } from "./lifecycle.js"
import type { Answer } from "./wire.js"

const CFG: IssuerConfig = {
  tokenUrl: "https://auth.example/token",
  clientId: "client-1",
  kid: "key-1",
  assertionLifetimeMs: 300_000,
  refreshMarginMs: 10_000
}

const NOW_MS = 1_700_000_000_000

const signerOf = (kid: string) => ({
  kid,
  sign: (claims: Readonly<Record<string, unknown>>) =>
    `head.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
})

const netOf = (plan: (url: string, body: string) => Answer) => {
  const seen: Array<{ url: string; body: string }> = []
  const post = (url: string, body: string) => {
    seen.push({ url, body })
    return Effect.succeed(plan(url, body))
  }
  return { post, seen }
}

const granted = (access: string, expiresIn = 3600): Answer => ({
  status: 200,
  url: CFG.tokenUrl,
  headers: {},
  body: JSON.stringify({ access_token: access, token_type: "Bearer", expires_in: expiresIn })
})

const clockAt = (ms: number) => ({ ms: () => ms })

describe("lifecycle", () => {
  it("obtains a token and reuses it within its life", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted("tok-1"))
    const lf = lifecycle(CFG, signer, held)
    const first = await Effect.runPromise(
      lf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
    )
    const second = await Effect.runPromise(
      lf.token().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS + 60_000)), Effect.provideService(TokenNet as never, net))
    )
    expect(first).toBe("tok-1")
    expect(second).toBe("tok-1")
    expect(net.seen.length).toBe(1)
  })

  it("refreshes on demand before expiry", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const issued = { now: "tok-old" }
    const net = netOf(() => granted(issued.now))
    const lf = lifecycle(CFG, signer, held)
    await Effect.runPromise(
      lf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
    )
    issued.now = "tok-new"
    const refreshed = await Effect.runPromise(
      lf.refresh().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS + 60_000)), Effect.provideService(TokenNet as never, net))
    )
    expect(refreshed).toBe("tok-new")
    expect(net.seen.length).toBe(2)
  })

  it("crossing the margin renews on the next call", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const issued = { now: "tok-1" }
    const net = netOf(() => granted(issued.now))
    const lf = lifecycle(CFG, signer, held)
    await Effect.runPromise(
      lf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
    )
    issued.now = "tok-2"
    const renewed = await Effect.runPromise(
      lf.token().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS + 3590_000)), Effect.provideService(TokenNet as never, net))
    )
    expect(renewed).toBe("tok-2")
    expect(net.seen.length).toBe(2)
  })

  it("refreshes each issuer on its own margin, never one shared", async () => {
    const nervous = { ...CFG, refreshMarginMs: 300_000 }
    const calm = { ...CFG, refreshMarginMs: 10_000 }
    const nervousNet = netOf(() => granted("nervous"))
    const calmNet = netOf(() => granted("calm"))
    const nervousLf = lifecycle(nervous, signerOf("key-1"), cache(nervous, signerOf("key-1")))
    const calmLf = lifecycle(calm, signerOf("key-1"), cache(calm, signerOf("key-1")))
    await Effect.runPromise(
      nervousLf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, nervousNet))
    )
    await Effect.runPromise(
      calmLf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, calmNet))
    )
    const fiveMinutesEarly = clockAt(NOW_MS + 3300_000)
    expect(
      await Effect.runPromise(
        nervousLf.token().pipe(Effect.provideService(TokenClock as never, fiveMinutesEarly), Effect.provideService(TokenNet as never, nervousNet))
      )
    ).toBe("nervous")
    expect(
      await Effect.runPromise(
        calmLf.token().pipe(Effect.provideService(TokenClock as never, fiveMinutesEarly), Effect.provideService(TokenNet as never, calmNet))
      )
    ).toBe("calm")
    expect(nervousNet.seen.length).toBe(2)
    expect(calmNet.seen.length).toBe(1)
  })

  it("names the expiry instead of retrying a dead grant", async () => {
    const signer = signerOf("key-1")
    const net = netOf(() => granted("never"))
    const expired = {
      refreshMarginMs: CFG.refreshMarginMs,
      issued: () => [],
      assert: () => ({ assertion: "x", aud: CFG.tokenUrl, exp: NOW_MS + 300_000 }),
      store: () => {},
      current: () => undefined,
      grant: () => ({ accessToken: "dead", tokenType: "Bearer", expiresAt: Math.floor(NOW_MS / 1000) - 1 }),
      invalidate: () => {}
    }
    const lf = lifecycle(CFG, signer, expired)
    const exit = await Effect.runPromiseExit(
      lf.token().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
    )
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Expired")
    expect(net.seen.length).toBe(0)
  })

  it("never lets a refresh loop disguise a refusal", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => ({ status: 401, url: CFG.tokenUrl, headers: {}, body: "{\"error\":\"invalid_grant\"}" }))
    const lf = lifecycle(CFG, signer, held)
    const exit = await Effect.runPromiseExit(
      lf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
    )
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail")
    expect(net.seen.length).toBe(1)
  })

  it("invalidates the grant so the next call exchanges afresh", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const issued = { now: "tok-1" }
    const net = netOf(() => granted(issued.now))
    const lf = lifecycle(CFG, signer, held)
    await Effect.runPromise(
      lf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
    )
    expect(net.seen.length).toBe(1)
    issued.now = "tok-2"
    await Effect.runPromise(lf.invalidate())
    const next = await Effect.runPromise(
      lf.token().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS + 60_000)), Effect.provideService(TokenNet as never, net))
    )
    expect(next).toBe("tok-2")
    expect(net.seen.length).toBe(2)
  })

  it("never places the token on any console", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted("unspoken-9", 3600))
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")] as const
    try {
      const lf = lifecycle(CFG, signer, held)
      const token = await Effect.runPromise(
        lf.obtain().pipe(Effect.provideService(TokenClock as never, clockAt(NOW_MS)), Effect.provideService(TokenNet as never, net))
      )
      expect(token).toBe("unspoken-9")
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    for (const spy of spies) {
      expect(spy.mock.calls.flat().map(String)).not.toContain("unspoken-9")
    }
  })
})