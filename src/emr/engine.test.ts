import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { generateKeyPairSync } from "node:crypto"
import type { FhirResource } from "../core/engine.js"
import type { Bundle } from "../core/engine.js"
import type { Config } from "../config/config.js"
import { UNRESTRICTED } from "../engine/restriction.js"
import type { Restriction } from "../engine/restriction.js"
import { creditOf, engineOf, overTransport, remoteEngine } from "../host/wiring.js"
import type { Startup } from "../host/wiring.js"
import type { BackendConfig } from "./backend.js"
import type { Answer, Bound, SendRequest } from "./wire.js"

const creditNone = (): Effect.Effect<Readonly<Record<string, string>>, never> =>
  Effect.succeed({})

const backend = (over: Partial<BackendConfig> = {}): BackendConfig => ({
  name: "clinic-a",
  baseUrl: "https://emr.example/fhir",
  provider: "generic",
  timeoutMs: 30000,
  retryAfterMs: 500,
  auth: { scheme: "none" },
  ...over
})

const config = (emr: BackendConfig | undefined): Config => ({
  transport: "stdio",
  http: { host: "127.0.0.1", port: 8080, origins: [] },
  store: { path: ":memory:" },
  allowWrite: false,
  scopes: [],
  terminologyDir: undefined,
  logLevel: "info",
  ...(emr === undefined ? {} : { emr })
})

const marker = (name: string) => ({
  read: () => Effect.succeed({ resourceType: "Marker", id: name } as FhirResource),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset" } as Bundle),
  resourceTypes: () => Effect.succeed([name]),
  searchParameters: () => Effect.succeed([])
})

const BOUND: Bound = { dependency: "clinic-a", timeoutMs: 30000, retryAfterMs: 500 }

const answer = (status: number, body: string): Answer => ({
  status,
  url: "https://emr.example/fhir",
  headers: {},
  body
})

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
}

describe("the emr engine behind the port", () => {
  it("reaches the server with the base url and an accept header", async () => {
    const sent: Array<Sent> = []
    const send = (request: SendRequest) => {
      sent.push(request)
      return Effect.succeed(answer(200, JSON.stringify({ resourceType: "Patient", id: "p1" })))
    }
    const engine = overTransport(backend(), creditNone, send)
    const found = await Effect.runPromise(engine.read("Patient", "p1"))
    expect(found).toEqual({ resourceType: "Patient", id: "p1" })
    expect(sent[0]?.method).toBe("GET")
    expect(sent[0]?.url).toBe("https://emr.example/fhir/Patient/p1")
    expect(sent[0]?.headers["accept"]).toBe("application/fhir+json")
  })

  it("carries the configured wait bounds on every call", async () => {
    let carried: Bound | undefined
    const send = (request: SendRequest) => {
      carried = request.bound
      return Effect.succeed(answer(200, "{\"resourceType\":\"Bundle\",\"type\":\"searchset\"}"))
    }
    const engine = overTransport(backend(), creditNone, send)
    await Effect.runPromise(engine.search({ type: "Patient", parameters: [] }))
    expect(carried).toEqual(BOUND)
  })

  it("builds a remote engine over the transport without calling out", () => {
    const engine = remoteEngine(backend())
    expect(typeof engine.read).toBe("function")
    expect(typeof engine.search).toBe("function")
  })
})

describe("engine selection by config", () => {
  it("serves the emr backend when configuration describes one", () => {
    const held = {} as unknown as Startup
    let chosen: BackendConfig | undefined
    const remote = (one: BackendConfig) => {
      chosen = one
      return marker("remote")
    }
    const engine = engineOf(held, UNRESTRICTED, config(backend()), remote, () => marker("local"))
    expect(chosen?.name).toBe("clinic-a")
    return engine.resourceTypes().pipe(Effect.map((types) => expect(types).toEqual(["remote"])))
  })

  it("keeps the store engine as the default without a backend", () => {
    const held = {} as unknown as Startup
    const restriction = UNRESTRICTED
    const remote = () => marker("remote")
    const local = (given: Startup, taken: Restriction) => {
      expect(given).toBe(held)
      expect(taken).toBe(restriction)
      return marker("local")
    }
    const engine = engineOf(held, restriction, config(undefined), remote, local)
    return engine.resourceTypes().pipe(Effect.map((types) => expect(types).toEqual(["local"])))
  })
})

describe("credit composition", () => {
  it("adds a bearer header from a configured token", async () => {
    const headers = await Effect.runPromise(
      creditOf(backend({ auth: { scheme: "bearer", token: "abc" } }))()
    )
    expect(headers["authorization"]).toBe("Bearer abc")
  })

  it("adds a basic header from configured credentials", async () => {
    const headers = await Effect.runPromise(
      creditOf(backend({ auth: { scheme: "basic", username: "u", password: "p" } }))()
    )
    expect(headers["authorization"]).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`)
  })

  it("adds no header without an auth scheme", async () => {
    const headers = await Effect.runPromise(creditOf(backend())())
    expect(headers).toEqual({})
  })

  it("wires a smart backend to a token-bearing credit", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const key = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const smart = backend({
      provider: "smart",
      auth: {
        scheme: "smart",
        tokenUrl: "https://auth.example/token",
        clientId: "client-1",
        kid: "key-1",
        key,
        assertionLifetimeMs: 300000,
        refreshMarginMs: 10000
      }
    })
    const credit = creditOf(smart)
    expect(typeof credit).toBe("function")
  })
})