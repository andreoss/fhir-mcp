import { describe, expect, it } from "vitest"
import { MissingField, parse, select } from "./backend.js"
import type { BackendInput } from "./backend.js"

const valid: BackendInput = {
  name: "clinic-a",
  baseUrl: "https://emr.example/fhir",
  provider: "smart",
  timeoutMs: "30000",
  retryAfterMs: "500",
  auth: {
    scheme: "smart",
    tokenUrl: "https://auth.example/token",
    clientId: "client-1",
    kid: "key-1",
    assertionLifetimeMs: "300000",
    refreshMarginMs: "10000"
  }
}

describe("backend config", () => {
  it("describes a smart backend with every field kept", () => {
    const parsed = parse(valid)
    expect(parsed.name).toBe("clinic-a")
    expect(parsed.baseUrl).toBe("https://emr.example/fhir")
    expect(parsed.provider).toBe("smart")
    expect(parsed.timeoutMs).toBe(30000)
    expect(parsed.retryAfterMs).toBe(500)
    expect(parsed.auth).toEqual({
      scheme: "smart",
      tokenUrl: "https://auth.example/token",
      clientId: "client-1",
      kid: "key-1",
      assertionLifetimeMs: 300000,
      refreshMarginMs: 10000
    })
  })

  it("refuses a missing name", () => {
    expect(() => parse({ ...valid, name: "  " })).toThrow(MissingField)
  })

  it("refuses a blank base url", () => {
    expect(() => parse({ ...valid, baseUrl: " " })).toThrow(MissingField)
  })

  it("refuses an unknown provider", () => {
    expect(() => parse({ ...valid, provider: "oracle" })).toThrow(MissingField)
  })

  it("refuses without an auth scheme", () => {
    expect(() => parse({ ...valid, auth: {} })).toThrow(MissingField)
  })

  it("refuses a smart backend missing its token url", () => {
    expect(() => parse({ ...valid, auth: { scheme: "smart", clientId: "c", kid: "k", assertionLifetimeMs: "1", refreshMarginMs: "1" } })).toThrow(MissingField)
  })

  it("refuses a negative timeout", () => {
    expect(() => parse({ ...valid, timeoutMs: "-5" })).toThrow(MissingField)
  })

  it("holds a bearer token when present", () => {
    const parsed = parse({ ...valid, provider: "generic", auth: { scheme: "bearer", token: "abc" } })
    expect(parsed.auth).toEqual({ scheme: "bearer", token: "abc" })
  })

  it("blanks nothing silently", () => {
    const partial: Omit<BackendInput, "baseUrl"> = {
      name: "clinic-a",
      provider: "smart",
      timeoutMs: "30000",
      retryAfterMs: "500",
      auth: { scheme: "smart", tokenUrl: "https://auth.example/token", clientId: "client-1" }
    }
    expect(() => parse(partial as BackendInput)).toThrow(MissingField)
  })

  it("selects a backend by name and finds none for another", () => {
    const first = parse(valid)
    const second = parse({ ...valid, name: "clinic-b" })
    const found = select([first, second], "clinic-b")
    expect(found?.name).toBe("clinic-b")
    expect(select([first, second], "clinic-c")).toBeUndefined()
  })
})