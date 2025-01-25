import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { FhirResource } from "../core/engine.js"
import { memberMatch } from "./member.js"
import type { Answer } from "./member.js"
import type { Grant } from "./grant.js"
import { Records } from "./records.js"
import { recordsOn } from "./duck.js"

const all: Grant = { read: true }

const SYSTEM = "urn:oid:1.2.3"

const put = (store: Versioned, body: FhirResource): Promise<void> =>
  Effect.runPromise(
    store.insertVersion({
      type: body.resourceType,
      id: String(body["id"]),
      versionId: 1,
      lastUpdated: "2024-01-01T00:00:00.000Z",
      deleted: false,
      body
    })
  )

const member = (
  id: string,
  value: string,
  system: string | undefined = SYSTEM
): FhirResource => ({
  resourceType: "Patient",
  id,
  identifier: [system === undefined ? { value } : { system, value }]
})

interface Kit {
  readonly store: Versioned
  readonly ask: (body: FhirResource, grant?: Grant) => Promise<Answer>
  readonly fail: (body: FhirResource, grant?: Grant) => Promise<string>
}

const withKit = async (use: (kit: Kit) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const store = await Effect.runPromise(versionedOn(connection))
  const reader = recordsOn(connection)
  const served = <A>(effect: Effect.Effect<A, unknown, Records>) =>
    Effect.provideService(effect, Records, reader)
  const ask = (body: FhirResource, grant: Grant = all) =>
    Effect.runPromise(served(memberMatch(body, grant)))
  const fail = async (body: FhirResource, grant: Grant = all) => {
    const result = await Effect.runPromiseExit(served(memberMatch(body, grant)))
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      return (result.cause.error as { _tag: string })._tag
    }
    throw new Error("expected a failure")
  }
  try {
    await use({ store, ask, fail })
  } finally {
    connection.closeSync()
  }
}

describe("member match", () => {
  it("answers with the patient and the identifier that matched", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      await put(store, member("p2", "9999"))
      const answer = await ask(member("incoming", "1234"))
      expect(answer._tag).toBe("Match")
      if (answer._tag !== "Match") throw new Error("expected a match")
      expect(answer.patient["id"]).toBe("p1")
      expect(answer.identifier).toEqual({ system: SYSTEM, value: "1234" })
    }))

  it("matches on value alone when the request names no system", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      const answer = await ask(member("incoming", "1234", undefined))
      expect(answer._tag).toBe("Match")
    }))

  it("says no match rather than answering with nothing", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      const answer = await ask(member("incoming", "5678"))
      expect(answer._tag).toBe("NoMatch")
      if (answer._tag !== "NoMatch") throw new Error("expected no match")
      expect(answer.outcome.resourceType).toBe("OperationOutcome")
      expect(answer.outcome.issue[0]?.code).toBe("not-found")
      expect(answer.outcome.issue[0]?.diagnostics).toContain("1.2.3|5678")
    }))

  it("says no match when the value matches under another system", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234", "urn:oid:9.9.9"))
      expect((await ask(member("incoming", "1234")))._tag).toBe("NoMatch")
    }))

  it("refuses to choose when more than one patient matches", () =>
    withKit(async ({ store, fail }) => {
      await put(store, member("p1", "1234"))
      await put(store, member("p2", "1234"))
      expect(await fail(member("incoming", "1234"))).toBe("Conflict")
    }))

  it("refuses a body that is not a patient", () =>
    withKit(async ({ fail }) => {
      expect(await fail({ resourceType: "Observation", id: "o1" })).toBe("Rejected")
    }))

  it("refuses a patient carrying no identifier", () =>
    withKit(async ({ fail }) => {
      expect(await fail({ resourceType: "Patient", id: "incoming" })).toBe("Rejected")
    }))

  it("refuses a grant that cannot read", () =>
    withKit(async ({ store, fail }) => {
      await put(store, member("p1", "1234"))
      expect(await fail(member("incoming", "1234"), { read: false })).toBe("Forbidden")
    }))

  it("says no match for a patient the grant does not reach", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      const answer = await ask(member("incoming", "1234"), { read: true, patients: ["p2"] })
      expect(answer._tag).toBe("NoMatch")
    }))

  it("matches on any of the identifiers the request carries", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      const incoming: FhirResource = {
        resourceType: "Patient",
        id: "incoming",
        identifier: [{ system: SYSTEM, value: "0000" }, { system: SYSTEM, value: "1234" }]
      }
      const answer = await ask(incoming)
      expect(answer._tag).toBe("Match")
    }))

  it("ignores an identifier entry carrying no value", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      const incoming: FhirResource = {
        resourceType: "Patient",
        id: "incoming",
        identifier: [{ system: SYSTEM }, { system: SYSTEM, value: "1234" }]
      }
      expect((await ask(incoming))._tag).toBe("Match")
    }))
})

describe("member match, identifier shapes", () => {
  it("passes over an identifier entry that is not an identifier", () =>
    withKit(async ({ store, ask }) => {
      await put(store, member("p1", "1234"))
      const incoming: FhirResource = {
        resourceType: "Patient",
        id: "incoming",
        identifier: ["1234", { system: SYSTEM, value: "1234" }]
      }
      expect((await ask(incoming))._tag).toBe("Match")
    }))
})
