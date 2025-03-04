import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { load } from "./config.js"

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
