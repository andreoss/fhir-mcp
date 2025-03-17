import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { load } from "./config.js"
import { seal } from "./secrets.js"

const run = (env: Record<string, string | undefined>) =>
  Effect.runSyncExit(load(env))

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const failure = <A>(exit: Exit.Exit<A, { readonly problems: ReadonlyArray<string> }>) => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected failure")
}

describe("config", () => {
  it("applies defaults when nothing is set", () => {
    const config = value(run({}))
    expect(config.transport).toBe("stdio")
    expect(config.http.host).toBe("127.0.0.1")
    expect(config.http.port).toBe(8080)
    expect(config.logLevel).toBe("info")
    expect(config.store.path).toBe(":memory:")
    expect(config.terminologyDir).toBeUndefined()
  })

  it("reads every supported key", () => {
    const config = value(run({
      FHIR_TRANSPORT: "http",
      FHIR_HTTP_HOST: "0.0.0.0",
      FHIR_HTTP_PORT: "9443",
      FHIR_HTTP_ORIGINS: "https://a.example, https://b.example",
      FHIR_STORE_PATH: "state.duckdb",
      FHIR_TERMINOLOGY_DIR: "terms",
      FHIR_LOG_LEVEL: "debug"
    }))
    expect(config.transport).toBe("http")
    expect(config.http.host).toBe("0.0.0.0")
    expect(config.http.port).toBe(9443)
    expect(config.http.origins).toEqual(["https://a.example", "https://b.example"])
    expect(config.store.path).toBe("state.duckdb")
    expect(config.terminologyDir).toBe("terms")
    expect(config.logLevel).toBe("debug")
  })

  it("names the key and the accepted values when a choice is wrong", () => {
    const error = failure(run({ FHIR_TRANSPORT: "carrier-pigeon" }))
    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toContain("FHIR_TRANSPORT")
    expect(error.problems[0]).toContain("stdio")
    expect(error.problems[0]).toContain("http")
  })

  it("names the key when a number is not a number", () => {
    const error = failure(run({ FHIR_HTTP_PORT: "eighty" }))
    expect(error.problems[0]).toContain("FHIR_HTTP_PORT")
  })

  it("rejects a port outside the usable range", () => {
    expect(failure(run({ FHIR_HTTP_PORT: "0" })).problems[0]).toContain("FHIR_HTTP_PORT")
    expect(failure(run({ FHIR_HTTP_PORT: "70000" })).problems[0]).toContain("FHIR_HTTP_PORT")
  })

  it("reports every problem at once, not the first", () => {
    const error = failure(run({ FHIR_TRANSPORT: "smoke", FHIR_LOG_LEVEL: "shout" }))
    expect(error.problems).toHaveLength(2)
    expect(error.problems.join(" ")).toContain("FHIR_TRANSPORT")
    expect(error.problems.join(" ")).toContain("FHIR_LOG_LEVEL")
  })

  it("requires an origin allow list before serving over http", () => {
    const error = failure(run({ FHIR_TRANSPORT: "http" }))
    expect(error.problems[0]).toContain("FHIR_HTTP_ORIGINS")
  })

  it("does not require an origin allow list over stdio", () => {
    expect(value(run({ FHIR_TRANSPORT: "stdio" })).http.origins).toEqual([])
  })

  it("refuses a non-loopback bind without an explicit origin allow list", () => {
    const error = failure(run({ FHIR_TRANSPORT: "http", FHIR_HTTP_HOST: "0.0.0.0" }))
    expect(error.problems.join(" ")).toContain("FHIR_HTTP_ORIGINS")
  })

  it("ignores keys it does not own", () => {
    expect(value(run({ UNRELATED: "x" })).transport).toBe("stdio")
  })

  it("trims surrounding space from values", () => {
    expect(value(run({ FHIR_STORE_PATH: "  state.duckdb  " })).store.path).toBe("state.duckdb")
  })

  it("treats an empty value as unset", () => {
    expect(value(run({ FHIR_HTTP_PORT: "   " })).http.port).toBe(8080)
  })
})

describe("emr backend config", () => {
  const smart: Record<string, string> = {
    FHIR_EMR_BACKEND: "clinic-a",
    FHIR_EMR_BASE_URL: "https://emr.example/fhir",
    FHIR_EMR_PROVIDER: "smart",
    FHIR_EMR_TIMEOUT_MS: "30000",
    FHIR_EMR_RETRY_AFTER_MS: "500",
    FHIR_EMR_AUTH_SCHEME: "smart",
    FHIR_EMR_AUTH_TOKEN_URL: "https://auth.example/token",
    FHIR_EMR_AUTH_CLIENT_ID: "client-1",
    FHIR_EMR_AUTH_KID: "key-1",
    FHIR_EMR_AUTH_KEY: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
    FHIR_EMR_AUTH_ASSERTION_LIFETIME_MS: "300000",
    FHIR_EMR_AUTH_REFRESH_MARGIN_MS: "10000"
  }

  it("describes a backend from its own fields", () => {
    const config = value(run(smart))
    expect(config.emr).toEqual({
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
        key: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
        assertionLifetimeMs: 300000,
        refreshMarginMs: 10000
      }
    })
  })

  it("describes a bearer backend with its token", () => {
    const config = value(run({
      FHIR_EMR_BACKEND: "clinic-b",
      FHIR_EMR_BASE_URL: "https://emr.example/fhir",
      FHIR_EMR_TIMEOUT_MS: "30000",
      FHIR_EMR_RETRY_AFTER_MS: "500",
      FHIR_EMR_AUTH_SCHEME: "bearer",
      FHIR_EMR_AUTH_TOKEN: "static-token"
    }))
    expect(config.emr?.auth).toEqual({ scheme: "bearer", token: "static-token" })
  })

  it("keeps the store backend as the default when no backend is described", () => {
    expect(value(run({})).emr).toBeUndefined()
  })

  it("refuses a backend with a blank name", () => {
    const error = failure(run({ ...smart, FHIR_EMR_BACKEND: "   " }))
    expect(error.problems[0]).toContain("name must be set and not blank")
  })

  it("refuses a backend with a blank base url", () => {
    const error = failure(run({ ...smart, FHIR_EMR_BASE_URL: "" }))
    expect(error.problems[0]).toContain("baseUrl must be set and not blank")
  })

  it("refuses a smart backend with a blank signing key", () => {
    const error = failure(run({ ...smart, FHIR_EMR_AUTH_KEY: " " }))
    expect(error.problems[0]).toContain("auth.key must be set and not blank")
  })

  it("refuses a backend described only by a blank field", () => {
    const error = failure(run({ FHIR_EMR_BACKEND: "   " }))
    expect(error.problems[0]).toContain("name must be set and not blank")
  })

  it("names a missing required field before anything connects", () => {
    const error = failure(run({ FHIR_EMR_BACKEND: "ghost", FHIR_EMR_AUTH_SCHEME: "basic" }))
    const message = error.problems.join(" ")
    expect(message).toContain("ghost")
    expect(message).toContain("baseUrl must be set and not blank")
  })

  it("keeps the per-issuer refresh margin from the backend, not one global value", () => {
    const low = value(run({ ...smart, FHIR_EMR_AUTH_REFRESH_MARGIN_MS: "10000" }))
    const high = value(run({ ...smart, FHIR_EMR_AUTH_REFRESH_MARGIN_MS: "300000" }))
    expect(low.emr?.auth).toMatchObject({ refreshMarginMs: 10000 })
    expect(high.emr?.auth).toMatchObject({ refreshMarginMs: 300000 })
  })

  it("decrypts a sealed secret with the key from the environment", () => {
    const key = "test-key-7f3c-1a9e"
    const sealed = seal("client-key-material", key)
    const config = value(run({ ...smart, FHIR_EMR_AUTH_KEY: sealed, FHIR_SECRET_KEY: key }))
    expect(config.emr?.auth).toMatchObject({ key: "client-key-material" })
  })

  it("never stores a secret value in plain form", () => {
    const key = "test-key-3b21-c0de"
    const sealed = seal("client-key-material", key)
    expect(sealed).not.toContain("client-key-material")
  })

  it("refuses a sealed secret when no key is set, naming the field", () => {
    const error = failure(run({ ...smart, FHIR_EMR_AUTH_KEY: seal("client-key-material", "some-key") }))
    expect(error.problems[0]).toContain("FHIR_EMR_AUTH_KEY")
    expect(error.problems[0]).toContain("no decryption key")
  })

  it("refuses a sealed secret under the wrong key, naming the field", () => {
    const error = failure(run({
      ...smart,
      FHIR_EMR_AUTH_KEY: seal("client-key-material", "real-key"),
      FHIR_SECRET_KEY: "wrong-key"
    }))
    expect(error.problems[0]).toContain("FHIR_EMR_AUTH_KEY")
    expect(error.problems[0]).toContain("decryption failed")
  })
})

describe("write toggle", () => {
  it("does not permit writing unless it is asked for", () => {
    expect(value(run({})).allowWrite).toBe(false)
  })

  it("permits writing when it is asked for", () => {
    expect(value(run({ FHIR_ALLOW_WRITE: "true" })).allowWrite).toBe(true)
  })

  it("refuses a value that is neither", () => {
    expect(failure(run({ FHIR_ALLOW_WRITE: "yes" })).problems[0]).toContain("FHIR_ALLOW_WRITE")
  })
})
