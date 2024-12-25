import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { load } from "../config/config.js"
import type { Config } from "../config/config.js"
import { tools } from "../agent/tools.js"
import { statusOf } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { NONE, discovery, document } from "./smart.js"
import type { Authz } from "./smart.js"

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const failure = <A>(exit: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected failure")
}

const config = (env: Record<string, string | undefined>): Config =>
  value(Effect.runSyncExit(load(env)))

const overHttp = config({
  FHIR_TRANSPORT: "http",
  FHIR_HTTP_ORIGINS: "https://a.example"
})

const granted: Authz = {
  endpoints: {
    issuer: "https://issuer.example",
    jwks: "https://issuer.example/jwks",
    authorization: "https://issuer.example/authorize",
    token: "https://issuer.example/token",
    registration: "https://issuer.example/register",
    introspection: "https://issuer.example/introspect"
  },
  capabilities: ["client-public", "context-standalone-patient"],
  scopes: ["patient/Patient.rs"],
  grants: ["authorization_code"],
  pkce: ["S256"]
}

describe("smart discovery", () => {
  it("advertises no endpoint this build does not have", () => {
    expect(Object.keys(document(NONE)).sort()).toEqual([
      "capabilities",
      "code_challenge_methods_supported",
      "grant_types_supported",
      "scopes_supported"
    ])
    expect(JSON.stringify(document(NONE))).not.toContain("http")
  })

  it("advertises no capability, scope or grant this build does not have", () => {
    const answered = document(NONE)
    expect(answered.capabilities).toEqual([])
    expect(answered.scopes_supported).toEqual([])
    expect(answered.grant_types_supported).toEqual([])
    expect(answered.code_challenge_methods_supported).toEqual([])
  })

  it("agrees with a tool surface that authorizes nothing", () => {
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/auth|token|register|introspect|scope/)
    }
    expect(NONE.capabilities).toEqual([])
    expect(NONE.endpoints).toEqual({})
  })

  it("carries exactly what an active authorization states", () => {
    expect(document(granted)).toEqual({
      issuer: "https://issuer.example",
      jwks_uri: "https://issuer.example/jwks",
      authorization_endpoint: "https://issuer.example/authorize",
      token_endpoint: "https://issuer.example/token",
      registration_endpoint: "https://issuer.example/register",
      introspection_endpoint: "https://issuer.example/introspect",
      capabilities: ["client-public", "context-standalone-patient"],
      scopes_supported: ["patient/Patient.rs"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"]
    })
  })

  it("names no field the state left out", () => {
    const partial: Authz = { ...NONE, endpoints: { token: "https://a.example/token" } }
    expect(Object.keys(document(partial))).toContain("token_endpoint")
    expect(Object.keys(document(partial))).not.toContain("authorization_endpoint")
  })

  it("has no document at all on the transport this build serves", () => {
    const error = failure(Effect.runSyncExit(discovery(config({}))))
    expect(statusOf(error)).toBe(404)
  })

  it("answers over http with what is active, which is nothing", () => {
    expect(value(Effect.runSyncExit(discovery(overHttp)))).toEqual(document(NONE))
  })

  it("answers over http with an active authorization when there is one", () => {
    const answered = value(Effect.runSyncExit(discovery(overHttp, granted)))
    expect(answered.token_endpoint).toBe("https://issuer.example/token")
  })
})
