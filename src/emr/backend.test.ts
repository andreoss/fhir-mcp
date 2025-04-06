import { describe, expect, it } from "vitest"
import { BackendRejected, parse, select } from "./backend.js"
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
    key: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
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
      key: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
      assertionLifetimeMs: 300000,
      refreshMarginMs: 10000
    })
  })

  it("refuses a missing name", () => {
    expect(() => parse({ ...valid, name: "  " })).toThrow(BackendRejected)
  })

  it("refuses a blank base url", () => {
    expect(() => parse({ ...valid, baseUrl: " " })).toThrow(BackendRejected)
  })

  it("refuses an unknown provider", () => {
    expect(() => parse({ ...valid, provider: "oracle" })).toThrow(BackendRejected)
  })

  it("refuses without an auth scheme", () => {
    expect(() => parse({ ...valid, auth: {} })).toThrow(BackendRejected)
  })

  it("refuses a smart backend missing its token url", () => {
    expect(() => parse({ ...valid, auth: { scheme: "smart", clientId: "c", kid: "k", key: "k", assertionLifetimeMs: "1", refreshMarginMs: "1" } })).toThrow(BackendRejected)
  })

  it("refuses a smart backend missing its signing key", () => {
    expect(() => parse({ ...valid, auth: { scheme: "smart", tokenUrl: "https://auth.example/token", clientId: "c", kid: "k" } })).toThrow(BackendRejected)
  })

  it("keeps an issued scope when one is named", () => {
    const parsed = parse({ ...valid, auth: { ...valid.auth, scope: "patient/Patient.read" } } as BackendInput)
    expect(parsed.auth).toEqual({
      scheme: "smart",
      tokenUrl: "https://auth.example/token",
      clientId: "client-1",
      kid: "key-1",
      key: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
      scope: "patient/Patient.read",
      assertionLifetimeMs: 300000,
      refreshMarginMs: 10000
    })
  })

  it("refuses a negative timeout", () => {
    expect(() => parse({ ...valid, timeoutMs: "-5" })).toThrow(BackendRejected)
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
    expect(() => parse(partial as BackendInput)).toThrow(BackendRejected)
  })

  it("selects a backend by name and finds none for another", () => {
     const first = parse(valid)
     const second = parse({ ...valid, name: "clinic-b" })
     const found = select([first, second], "clinic-b")
     expect(found?.name).toBe("clinic-b")
     expect(select([first, second], "clinic-c")).toBeUndefined()
   })
 })

describe("emr-03 configuration describes a backend with nothing silently blank", () => {
  const rejected = (input: BackendInput): string => {
    try {
      parse(input)
    } catch (error) {
      if (error instanceof BackendRejected) {
        return error.problems.map((problem) => problem.message).join("\n")
      }
      throw error
    }
    throw new Error("expected a rejection")
  }

  const withoutAuth = (fields: Record<string, string | undefined>): BackendInput => ({
    name: "clinic-a",
    baseUrl: "https://emr.example/fhir",
    provider: "generic",
    timeoutMs: "30000",
    retryAfterMs: "500",
    auth: fields
  })

  it("accepts a complete backend and keeps every described value", () => {
    expect(parse(withoutAuth({ scheme: "none" }))).toEqual({
      name: "clinic-a",
      baseUrl: "https://emr.example/fhir",
      provider: "generic",
      timeoutMs: 30000,
      retryAfterMs: 500,
      auth: { scheme: "none" }
    })
  })

  it("refuses a backend with no base url, naming the field", () => {
    const message = rejected({ ...withoutAuth({ scheme: "none" }), baseUrl: undefined })
    expect(message).toContain("clinic-a: baseUrl must be set and not blank")
  })

  it("refuses a backend with an empty name, naming the field", () => {
    expect(rejected({ ...withoutAuth({ scheme: "none" }), name: "" })).toContain(
      "name must be set and not blank"
    )
  })

  it("names every blank field of a smart scheme at once", () => {
    const message = rejected(
      withoutAuth({
        scheme: "smart",
        assertionLifetimeMs: "300000",
        refreshMarginMs: "10000"
      })
    )
    expect(message).toContain("auth.tokenUrl must be set and not blank")
    expect(message).toContain("auth.clientId must be set and not blank")
    expect(message).toContain("auth.kid must be set and not blank")
    expect(message).toContain("auth.key must be set and not blank")
  })

  it("refuses a smart scheme named but carrying no other value", () => {
    const message = rejected(withoutAuth({ scheme: "smart" }))
    expect(message).toContain("auth.assertionLifetimeMs must be set and not blank")
    expect(message).toContain("auth.refreshMarginMs must be set and not blank")
  })

  it("refuses a non-positive timeout, naming the field and the value", () => {
    for (const value of ["0", "-5"]) {
      const message = rejected({ ...withoutAuth({ scheme: "none" }), timeoutMs: value })
      expect(message).toContain("timeoutMs")
      expect(message).toContain("greater than zero")
      expect(message).toContain(value)
    }
  })

  it("refuses a timeout that is not a number", () => {
    const message = rejected({ ...withoutAuth({ scheme: "none" }), timeoutMs: "soon" })
    expect(message).toContain("timeoutMs")
    expect(message).toContain("greater than zero")
  })

  it("refuses a non-positive retry delay", () => {
    expect(rejected({ ...withoutAuth({ scheme: "none" }), retryAfterMs: "0" })).toContain(
      "retryAfterMs"
    )
  })

  it("refuses a backend with no provider rather than choosing one for it", () => {
    expect(rejected({ ...withoutAuth({ scheme: "none" }), provider: undefined })).toContain(
      "provider must be set and not blank"
    )
  })

  it("refuses a provider outside the known names, naming what is accepted", () => {
    const message = rejected({ ...withoutAuth({ scheme: "none" }), provider: "cerner" })
    expect(message).toContain("provider")
    expect(message).toContain("generic")
    expect(message).toContain("smart")
    expect(message).toContain("cerner")
  })

  it("refuses a backend with no auth scheme rather than defaulting to none", () => {
    const partial: Omit<BackendInput, "auth"> = {
      name: "clinic-a",
      baseUrl: "https://emr.example/fhir",
      provider: "generic",
      timeoutMs: "30000",
      retryAfterMs: "500"
    }
    expect(rejected(partial)).toContain("auth.scheme must be set and not blank")
  })

  it("refuses an unknown auth scheme, naming what is accepted", () => {
    const message = rejected(withoutAuth({ scheme: "digest" }))
    expect(message).toContain("auth.scheme")
    expect(message).toContain("smart")
  })

  it("refuses a bearer scheme with a blank token", () => {
    expect(rejected(withoutAuth({ scheme: "bearer", token: " " }))).toContain(
      "auth.token must be set and not blank"
    )
  })

  it("refuses a basic scheme missing its password", () => {
    expect(rejected(withoutAuth({ scheme: "basic", username: "reader" }))).toContain(
      "auth.password must be set and not blank"
    )
  })
})