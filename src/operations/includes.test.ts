import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { FhirResource } from "../core/engine.js"
import { includes } from "./includes.js"
import type { Includes } from "./includes.js"
import type { Grant } from "./grant.js"
import { Records } from "./records.js"
import { recordsOn } from "./duck.js"
import type { Page } from "./page.js"

const all: Grant = { read: true }

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

interface Kit {
  readonly store: Versioned
  readonly ask: (request: Includes, grant?: Grant) => Promise<Page>
  readonly fail: (request: Includes, grant?: Grant) => Promise<string>
}

const withKit = async (use: (kit: Kit) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const store = await Effect.runPromise(versionedOn(connection))
  const reader = recordsOn(connection)
  const served = <A>(effect: Effect.Effect<A, unknown, Records>) =>
    Effect.provideService(effect, Records, reader)
  const ask = (request: Includes, grant: Grant = all) =>
    Effect.runPromise(served(includes(request, grant)))
  const fail = async (request: Includes, grant: Grant = all) => {
    const result = await Effect.runPromiseExit(served(includes(request, grant)))
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
  await put(store, { resourceType: "Patient", id: "p1" })
  await put(store, { resourceType: "Encounter", id: "e1", subject: { reference: "Patient/p1" } })
  await put(store, {
    resourceType: "Observation",
    id: "o1",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" }
  })
  await put(store, {
    resourceType: "Observation",
    id: "o2",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" }
  })
  await put(store, {
    resourceType: "Condition",
    id: "c1",
    subject: { reference: "Patient/p1/_history/1" }
  })
}

const held = (page: Page): ReadonlyArray<string> => page.entry.map((one) => String(one.fullUrl))

const seed = (type: string, id: string) => ({ type, id })

describe("includes", () => {
  it("returns what the named resources point at", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask({ of: [seed("Observation", "o1")] })
      expect(held(page)).toEqual(["Encounter/e1", "Patient/p1"])
      expect(page.total).toBe(2)
    }))

  it("returns a resource once however many point at it", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask({ of: [seed("Observation", "o1"), seed("Observation", "o2")] })
      expect(held(page)).toEqual(["Encounter/e1", "Patient/p1"])
    }))

  it("does not return the resources it was given", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask({ of: [seed("Observation", "o1"), seed("Encounter", "e1")] })
      expect(held(page)).toEqual(["Patient/p1"])
    }))

  it("reads a reference that carries a version", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      expect(held(await ask({ of: [seed("Condition", "c1")] }))).toEqual(["Patient/p1"])
    }))

  it("passes over a reference to something not held", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      await put(store, {
        resourceType: "Observation",
        id: "o9",
        subject: { reference: "Patient/gone" }
      })
      expect(held(await ask({ of: [seed("Observation", "o9")] }))).toEqual([])
    }))

  it("passes over a related resource that was deleted", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      await Effect.runPromise(store.markDeleted("Encounter", "e1", 2, "2024-01-02T00:00:00.000Z"))
      expect(held(await ask({ of: [seed("Observation", "o1")] }))).toEqual(["Patient/p1"])
    }))

  it("narrows to the types asked for", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask({ of: [seed("Observation", "o1")], types: ["Patient"] })
      expect(held(page)).toEqual(["Patient/p1"])
    }))

  it("reports a resource it was given that is not held", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ of: [seed("Observation", "o9")] })).toBe("NotFound")
    }))

  it("refuses a request naming nothing", () =>
    withKit(async ({ fail }) => {
      expect(await fail({ of: [] })).toBe("Rejected")
    }))

  it("refuses a name that is not a resource type and id", () =>
    withKit(async ({ fail }) => {
      expect(await fail({ of: [seed("observation", "o1")] })).toBe("Rejected")
      expect(await fail({ of: [seed("Observation", "not an id")] })).toBe("Rejected")
    }))
})

describe("includes, authorization", () => {
  it("refuses a grant that cannot read", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(await fail({ of: [seed("Observation", "o1")] }, { read: false })).toBe("Forbidden")
    }))

  it("refuses a named resource the grant does not cover", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(
        await fail({ of: [seed("Observation", "o1")] }, { read: true, types: ["Patient"] })
      ).toBe("Forbidden")
    }))

  it("refuses a narrowing the grant does not cover", () =>
    withKit(async ({ store, fail }) => {
      await filled(store)
      expect(
        await fail(
          { of: [seed("Observation", "o1")], types: ["Encounter"] },
          { read: true, types: ["Observation", "Patient"] }
        )
      ).toBe("Forbidden")
    }))

  it("leaves out a related resource the grant does not cover", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const page = await ask(
        { of: [seed("Observation", "o1")] },
        { read: true, types: ["Observation", "Patient"] }
      )
      expect(held(page)).toEqual(["Patient/p1"])
    }))
})

describe("includes, paging", () => {
  it("walks the related resources page by page", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      const first = await ask({ of: [seed("Observation", "o1")], count: 1 })
      expect(held(first)).toEqual(["Encounter/e1"])
      expect(first.total).toBe(2)
      const token = new URLSearchParams(
        String(first.link.find((one) => one.relation === "next")?.url).split("?")[1]
      ).get("_ct")
      const second = await ask({ of: [seed("Observation", "o1")], count: 1, ct: String(token) })
      expect(held(second)).toEqual(["Patient/p1"])
      expect(second.link.some((one) => one.relation === "next")).toBe(false)
    }))

  it("refuses a token issued for another set of resources", () =>
    withKit(async ({ store, ask, fail }) => {
      await filled(store)
      const first = await ask({ of: [seed("Observation", "o1")], count: 1 })
      const token = new URLSearchParams(
        String(first.link.find((one) => one.relation === "next")?.url).split("?")[1]
      ).get("_ct")
      expect(await fail({ of: [seed("Observation", "o2")], count: 1, ct: String(token) })).toBe(
        "Rejected"
      )
    }))
})

describe("includes, references in a list", () => {
  it("reads a reference held in a list", () =>
    withKit(async ({ store, ask }) => {
      await filled(store)
      await put(store, {
        resourceType: "Observation",
        id: "o8",
        performer: [{ reference: "Patient/p1" }, { reference: "Encounter/e1" }]
      })
      expect(held(await ask({ of: [seed("Observation", "o8")] }))).toEqual([
        "Encounter/e1",
        "Patient/p1"
      ])
    }))
})
