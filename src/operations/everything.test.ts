import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { FhirResource } from "../core/engine.js"
import { everything } from "./everything.js"
import type { Everything } from "./everything.js"
import type { Grant } from "./grant.js"
import { Records } from "./records.js"
import { recordsOn } from "./duck.js"
import type { Page } from "./page.js"

const all: Grant = { read: true }

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const put = (store: Versioned, body: FhirResource, when: string): Promise<void> =>
  Effect.runPromise(
    store.insertVersion({
      type: body.resourceType,
      id: String(body["id"]),
      versionId: 1,
      lastUpdated: when,
      deleted: false,
      body
    })
  )

const patient = (id: string): FhirResource => ({ resourceType: "Patient", id })

const about = (type: string, id: string, of: string): FhirResource => ({
  resourceType: type,
  id,
  subject: { reference: `Patient/${of}` }
})

interface Kit {
  readonly store: Versioned
  readonly ask: (request: Everything, grant?: Grant) => Promise<Page>
  readonly fail: (request: Everything, grant?: Grant) => Promise<string>
}

const withKit = async (use: (kit: Kit) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const store = await Effect.runPromise(versionedOn(connection))
  const reader = recordsOn(connection)
  const served = <A>(effect: Effect.Effect<A, unknown, Records>) =>
    Effect.provideService(effect, Records, reader)
  const ask = (request: Everything, grant: Grant = all) =>
    Effect.runPromise(served(everything(request, grant)))
  const fail = async (request: Everything, grant: Grant = all) => {
    const result = await Effect.runPromiseExit(served(everything(request, grant)))
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

const filled = async (store: Versioned): Promise<void> => {
  await put(store, patient("p1"), moment(1))
  await put(store, patient("p2"), moment(1))
  await put(store, about("Observation", "o1", "p1"), moment(2))
  await put(store, about("Observation", "o2", "p1"), moment(9))
  await put(store, about("Condition", "c1", "p1"), moment(3))
  await put(store, about("Encounter", "e1", "p1"), moment(4))
  await put(store, about("Observation", "o3", "p2"), moment(5))
}

const held = (page: Page): ReadonlyArray<string> => page.entry.map((one) => String(one.fullUrl))

describe("patient everything", () => {
  it("gathers the patient and everything in its compartment", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask({ patient: "p1" })
      expect(held(page)).toEqual([
        "Condition/c1",
        "Encounter/e1",
        "Observation/o1",
        "Observation/o2",
        "Patient/p1"
      ])
      expect(page.total).toBe(5)
    }))

  it("leaves out what belongs to another patient", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      expect(held(await ask({ patient: "p2" }))).toEqual(["Observation/o3", "Patient/p2"])
    }))

  it("reports a patient that was never written", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ patient: "p9" })).toBe("NotFound")
    }))

  it("reports a patient that was deleted", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      await Effect.runPromise(store.markDeleted("Patient", "p1", 2, moment(6)))
      expect(await fail({ patient: "p1" })).toBe("Gone")
    }))

  it("leaves out a deleted member of the compartment", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      await Effect.runPromise(store.markDeleted("Observation", "o1", 2, moment(6)))
      expect(held(await ask({ patient: "p1" }))).not.toContain("Observation/o1")
    }))

  it("refuses an id that is not a resource id", () =>
    withKit(async ({ fail }) => {
      expect(await fail({ patient: "not an id" })).toBe("Rejected")
    }))
})

describe("patient everything, narrowed", () => {
  it("honours a lower bound on when a resource last changed", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      expect(held(await ask({ patient: "p1", since: moment(4) }))).toEqual([
        "Encounter/e1",
        "Observation/o2"
      ])
    }))

  it("honours an upper bound on when a resource last changed", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      expect(held(await ask({ patient: "p1", till: moment(3) }))).toEqual([
        "Condition/c1",
        "Observation/o1",
        "Patient/p1"
      ])
    }))

  it("takes a plain date as a whole day", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      expect(held(await ask({ patient: "p1", since: "2024-01-01", till: "2024-01-01" })).length)
        .toBe(5)
      expect(held(await ask({ patient: "p1", since: "2024-01-02" }))).toEqual([])
    }))

  it("refuses a bound that is not a date", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ patient: "p1", since: "yesterday" })).toBe("Rejected")
      expect(await fail({ patient: "p1", till: "yesterday" })).toBe("Rejected")
    }))

  it("honours the types asked for", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      expect(held(await ask({ patient: "p1", types: ["Observation"] }))).toEqual([
        "Observation/o1",
        "Observation/o2"
      ])
    }))

  it("refuses a type that is not in the patient compartment", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ patient: "p1", types: ["Practitioner"] })).toBe("Rejected")
    }))
})

describe("patient everything, authorization", () => {
  it("refuses a grant that cannot read", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ patient: "p1" }, { read: false })).toBe("Forbidden")
    }))

  it("refuses a patient the grant does not reach", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ patient: "p1" }, { read: true, patients: ["p2"] })).toBe("Forbidden")
    }))

  it("refuses a type the grant does not cover", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(
        await fail({ patient: "p1", types: ["Observation"] }, { read: true, types: ["Patient"] })
      ).toBe("Forbidden")
    }))

  it("gathers only the types the grant covers when none are asked for", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask({ patient: "p1" }, { read: true, types: ["Patient", "Condition"] })
      expect(held(page)).toEqual(["Condition/c1", "Patient/p1"])
    }))
})

describe("patient everything, paging", () => {
  it("walks the whole compartment page by page", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const first = await ask({ patient: "p1", count: 2 })
      expect(held(first)).toEqual(["Condition/c1", "Encounter/e1"])
      expect(first.total).toBe(5)
      const token = new URLSearchParams(
        String(first.link.find((one) => one.relation === "next")?.url).split("?")[1]
      ).get("_ct")
      const second = await ask({ patient: "p1", count: 2, ct: String(token) })
      expect(held(second)).toEqual(["Observation/o1", "Observation/o2"])
      const last = new URLSearchParams(
        String(second.link.find((one) => one.relation === "next")?.url).split("?")[1]
      ).get("_ct")
      const third = await ask({ patient: "p1", count: 2, ct: String(last) })
      expect(held(third)).toEqual(["Patient/p1"])
      expect(third.link.some((one) => one.relation === "next")).toBe(false)
    }))

  it("refuses a token issued for another patient", () =>
    withKit(async ({ store, ask, fail }) => {
      await filled(store)
      const first = await ask({ patient: "p1", count: 2 })
      const token = new URLSearchParams(
        String(first.link.find((one) => one.relation === "next")?.url).split("?")[1]
      ).get("_ct")
      expect(await fail({ patient: "p2", count: 2, ct: String(token) })).toBe("Rejected")
      expect(held(await ask({ patient: "p1", count: 2, ct: String(token) })).length).toBe(2)
    }))

  it("refuses a token presented with a different narrowing", () =>
    withKit(async ({ store, ask, fail }) => {
      await filled(store)
      const first = await ask({ patient: "p1", count: 2 })
      const token = new URLSearchParams(
        String(first.link.find((one) => one.relation === "next")?.url).split("?")[1]
      ).get("_ct")
      expect(
        await fail({ patient: "p1", count: 2, types: ["Observation"], ct: String(token) })
      ).toBe("Rejected")
    }))

  it("refuses a page size that is not a page size", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ patient: "p1", count: 0 })).toBe("Rejected")
    }))
})

describe("patient everything, store loss", () => {
  it("reports a store it cannot reach", async () => {
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    await Effect.runPromise(versionedOn(connection))
    const reader = recordsOn(connection)
    connection.closeSync()
    const result = await Effect.runPromiseExit(
      Effect.provideService(everything({ patient: "p1" }, all), Records, reader)
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      expect((result.cause.error as { _tag: string })._tag).toBe("Unavailable")
    }
  })
})
