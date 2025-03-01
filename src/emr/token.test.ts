import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { AudienceMismatch, Denied, TokenClock, TokenNet, cache, exchange } from "./token.js"
import type { IssuerConfig } from "./token.js"
import type { Answer } from "./wire.js"

const CFG: IssuerConfig = {
  tokenUrl: "https://auth.example:8443/TOKEN",
  clientId: "client-1",
  kid: "key-1",
  assertionLifetimeMs: 300_000,
  refreshMarginMs: 10_000
}

const NOW_MS = 1_700_000_000_000

const signerOf = (kid: string) => {
  const signed: Array<Readonly<Record<string, unknown>>> = []
  return {
    kid,
    sign: (claims: Readonly<Record<string, unknown>>) => {
      const copy = { ...claims }
      signed.push(copy)
      return `head.${Buffer.from(JSON.stringify(copy)).toString("base64url")}.sig`
    },
    signed
  }
}

const claimsOf = (assertion: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf-8"))

const netOf = (send: (url: string, body: string) => Answer) => {
  const seen: Array<{ url: string; body: string }> = []
  const post = (url: string, body: string) => {
    seen.push({ url, body })
    return Effect.succeed(send(url, body))
  }
  return { post, seen }
}

const clock = { ms: () => NOW_MS }

const granted = (body: string, status = 200): Answer => ({
  status,
  url: CFG.tokenUrl,
  headers: {},
  body
})

describe("assertion", () => {
  it("carries a kid, an exact audience, a bounded life and a nonce", () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const signed = held.assert(NOW_MS)
    const claims = claimsOf(signed.assertion)
    expect(signer.kid).toBe("key-1")
    expect(claims["kid"]).toBeUndefined()
    expect(claims["aud"]).toBe("https://auth.example:8443/TOKEN")
    expect(claims["iss"]).toBe("client-1")
    expect(claims["sub"]).toBe("client-1")
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(300)
    expect(typeof claims["jti"]).toBe("string")
  })

  it("keeps the audience verbatim, not normalized", () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const signed = held.assert(NOW_MS)
    expect(signed.aud).toBe("https://auth.example:8443/TOKEN")
    expect(claimsOf(signed.assertion)["aud"]).toBe("https://auth.example:8443/TOKEN")
  })

  it("tracks each nonce and never repeats one", () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const first = held.assert(NOW_MS)
    const second = held.assert(NOW_MS + 1000)
    const jtis = [claimsOf(first.assertion)["jti"], claimsOf(second.assertion)["jti"]]
    expect(jtis[0]).not.toBe(jtis[1])
    expect(held.issued()).toContain(jtis[0])
    expect(held.issued()).toContain(jtis[1])
    expect(new Set(held.issued()).size).toBe(held.issued().length)
  })
})

describe("exchange", () => {
  it("posts a client-credentials form to the token endpoint and keeps the token", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 })))
    const token = await Effect.runPromise(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    expect(token.accessToken).toBe("tok-1")
    expect(token.tokenType).toBe("Bearer")
    expect(token.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 3600)
    expect(net.seen[0]?.url).toBe(CFG.tokenUrl)
    const form = new URLSearchParams(net.seen[0]?.body ?? "")
    expect(form.get("grant_type")).toBe("client_credentials")
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
    expect(form.get("client_assertion")).toContain("head.")
  })

  it("reuses the cached token until the margin", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "tok-1", expires_in: 3600 })))
    const first = await Effect.runPromise(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    const second = await Effect.runPromise(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    expect(first.accessToken).toBe("tok-1")
    expect(second.accessToken).toBe("tok-1")
    expect(net.seen.length).toBe(1)
  })

  it("refreshes once the margin is crossed", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "tok-1", expires_in: 3600 })))
    await Effect.runPromise(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    const later = { ms: () => NOW_MS + 3600 * 1000 + 1 }
    const refreshed = await Effect.runPromise(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, later), Effect.provideService(TokenNet as never, net))
    )
    expect(refreshed.accessToken).toBe("tok-1")
    expect(net.seen.length).toBe(2)
  })

  it("refuses when the assertion kid does not match", async () => {
    const signer = signerOf("wrong-key")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "tok-1" })))
    const exit = await Effect.runPromiseExit(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error instanceof AudienceMismatch).toBe(true)
    expect(net.seen.length).toBe(0)
  })

  it("refuses audibly when the audience drifts from the endpoint", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "tok-1" })))
    const drifted = { ...held, assert: () => ({ assertion: "x", aud: "https://else.example/token", exp: NOW_MS + 300_000 }) }
    const exit = await Effect.runPromiseExit(
      exchange(CFG, signer, drifted).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error instanceof AudienceMismatch).toBe(true)
    expect(net.seen.length).toBe(0)
  })

  it("refuses audibly when the assertion has already elapsed", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "tok-1" })))
    const elapsed = { ...held, assert: () => ({ assertion: "x", aud: CFG.tokenUrl, exp: NOW_MS - 1 }) }
    const exit = await Effect.runPromiseExit(
      exchange(CFG, signer, elapsed).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Expired")
    expect(net.seen.length).toBe(0)
  })

  it("fails by name when the endpoint refuses", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ error: "invalid_client" }), 401))
    const exit = await Effect.runPromiseExit(
      exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
    )
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error instanceof Denied).toBe(true)
  })

  it("never exposes the token on any console", async () => {
    const signer = signerOf("key-1")
    const held = cache(CFG, signer)
    const net = netOf(() => granted(JSON.stringify({ access_token: "top-secret-7", expires_in: 3600 })))
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")] as const
    try {
      const token = await Effect.runPromise(
        exchange(CFG, signer, held).pipe(Effect.provideService(TokenClock as never, clock), Effect.provideService(TokenNet as never, net))
      )
      expect(token.accessToken).toBe("top-secret-7")
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    for (const spy of spies) {
      expect(spy.mock.calls.flat().map(String)).not.toContain("top-secret-7")
    }
  })
})