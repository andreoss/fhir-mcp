import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Failure } from "../core/outcome.js"
import { NotFound, Unavailable } from "../core/outcome.js"
import { remote } from "./adapter.js"
import type { SendRequest } from "./wire.js"
import type { Answer, Bound } from "./wire.js"

const BOUND: Bound = { dependency: "emr", timeoutMs: 60, retryAfterMs: 250 }

interface Sent {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

const transportOf = (plan: (sent: Sent) => Answer | Failure) => {
  const seen: Array<Sent> = []
  const send = (request: SendRequest) => {
    const note: Sent = { method: request.method, url: request.url, headers: request.headers, body: request.body }
    seen.push(note)
    const reply = plan(note)
    if (reply instanceof Error && reply._tag !== undefined) {
      return Effect.fail(reply as never)
    }
    return Effect.succeed(reply as Answer)
  }
  return { send, seen }
}

const answer = (status: number, body: string, headers: Record<string, string> = {}): Answer => ({
  status,
  url: "https://emr.example/fhir",
  headers,
  body
})

const creditNone = (): Effect.Effect<Readonly<Record<string, string>>, never> => Effect.succeed({})

const resource = { resourceType: "Patient", id: "p1", name: [{ family: "Doe" }] }

describe("adapter read", () => {
  it("fetches a resource by type and id", async () => {
    const fake = transportOf(() => answer(200, JSON.stringify(resource), { "content-type": "application/fhir+json" }))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const found = await Effect.runPromise(engine.read("Patient", "p1"))
    expect(found).toEqual(resource)
    expect(fake.seen[0]?.method).toBe("GET")
    expect(fake.seen[0]?.url).toBe("https://emr.example/fhir/Patient/p1")
    expect(fake.seen[0]?.headers["accept"]).toBe("application/fhir+json")
  })

  it("names a missing resource", async () => {
    const fake = transportOf(() => answer(404, "{\"resourceType\":\"OperationOutcome\"}"))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const exit = await Effect.runPromiseExit(engine.read("Patient", "ghost"))
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof NotFound) {
      expect(exit.cause.error.type).toBe("Patient")
      expect(exit.cause.error.id).toBe("ghost")
    } else {
      throw new Error("expected NotFound")
    }
  })

  it("names a deleted resource", async () => {
    const fake = transportOf(() => answer(410, "{\"resourceType\":\"OperationOutcome\"}"))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const exit = await Effect.runPromiseExit(engine.read("Patient", "gone"))
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Gone")
  })

  it("refuses a body that is not a resource", async () => {
    const fake = transportOf(() => answer(200, "<html>"))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const exit = await Effect.runPromiseExit(engine.read("Patient", "p1"))
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Rejected")
  })

  it("reports an unreachable upstream as unavailable", async () => {
    const fake = transportOf(() => new Unavailable({ dependency: "emr (retry after 250ms)" }))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const exit = await Effect.runPromiseExit(engine.read("Patient", "p1"))
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Unavailable")
  })
})

describe("adapter search", () => {
  const bundle = {
    resourceType: "Bundle",
    type: "searchset",
    total: 2,
    entry: [{ resource: resource }, { resource: { resourceType: "Patient", id: "p2" } }]
  }

  it("queries the type with parameters and shapes the bundle", async () => {
    const fake = transportOf(() => answer(200, JSON.stringify(bundle)))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const found = await Effect.runPromise(
      engine.search({ type: "Patient", parameters: [["name", "Doe"]], offset: 10, limit: 5 })
    )
    expect(found.resourceType).toBe("Bundle")
    expect(found.total).toBe(2)
    expect(found.entry?.length).toBe(2)
    const url = fake.seen[0]?.url ?? ""
    expect(url).toContain("name=Doe")
    expect(url).toContain("_count=5")
    expect(url).toContain("_offset=10")
  })

  it("parses only a searchset bundle", async () => {
    const fake = transportOf(() => answer(200, JSON.stringify({ resourceType: "Patient", id: "p1" })))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const exit = await Effect.runPromiseExit(engine.search({ type: "Patient", parameters: [] }))
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Rejected")
  })
})

describe("adapter conformance", () => {
  const statement = {
    resourceType: "CapabilityStatement",
    rest: [
      {
        resource: [
          { type: "Patient", searchParam: [{ name: "name" }, { name: "identifier" }] },
          { type: "Observation", searchParam: [{ name: "code" }] }
        ]
      }
    ]
  }

  it("lists the types the server declares", async () => {
    const fake = transportOf(() => answer(200, JSON.stringify(statement)))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const types = await Effect.runPromise(engine.resourceTypes())
    expect(types).toEqual(["Patient", "Observation"])
    expect(fake.seen[0]?.url).toContain("metadata")
  })

  it("lists the parameters of a type", async () => {
    const fake = transportOf(() => answer(200, JSON.stringify(statement)))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const params = await Effect.runPromise(engine.searchParameters("Patient"))
    expect(params).toEqual(["name", "identifier"])
  })

  it("offers an empty set when no resource matches", async () => {
    const fake = transportOf(() => answer(200, JSON.stringify(statement)))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const params = await Effect.runPromise(engine.searchParameters("Device"))
    expect(params).toEqual([])
  })

  it("fails like a dependency when conformance is unreachable", async () => {
    const fake = transportOf(() => new Unavailable({ dependency: "emr" }))
    const engine = remote({ baseUrl: "https://emr.example/fhir", bound: BOUND, credit: creditNone, send: fake.send })
    const exit = await Effect.runPromiseExit(engine.resourceTypes())
    expect(exit._tag === "Failure" && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("Unavailable")
  })
})