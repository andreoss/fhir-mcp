import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { FhirResource } from "../core/engine.js"
import { byParameters, byQuery } from "./docref.js"
import type { Grant } from "./grant.js"
import { Records } from "./records.js"
import { recordsOn } from "./duck.js"
import type { Page, Params } from "./page.js"

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

const document = (id: string, of: string, when: string): FhirResource => ({
  resourceType: "DocumentReference",
  id,
  status: "current",
  subject: { reference: `Patient/${of}` },
  date: when
})

type Entry = { readonly name: string } & Record<string, unknown>

const parameters = (entry: ReadonlyArray<Entry>): FhirResource => ({
  resourceType: "Parameters",
  parameter: entry
})

interface Kit {
  readonly store: Versioned
  readonly get: (params: Params, grant?: Grant) => Promise<Page>
  readonly post: (body: unknown, grant?: Grant) => Promise<Page>
  readonly getFails: (params: Params, grant?: Grant) => Promise<string>
  readonly postFails: (body: unknown, grant?: Grant) => Promise<string>
}

const tagOf = async <A>(effect: Effect.Effect<A, unknown, never>): Promise<string> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const withKit = async (use: (kit: Kit) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const store = await Effect.runPromise(versionedOn(connection))
  const reader = recordsOn(connection)
  const served = <A>(effect: Effect.Effect<A, unknown, Records>) =>
    Effect.provideService(effect, Records, reader)
  const kit: Kit = {
    store,
    get: (params, grant = all) => Effect.runPromise(served(byQuery(params, grant))),
    post: (body, grant = all) => Effect.runPromise(served(byParameters(body, grant))),
    getFails: (params, grant = all) => tagOf(served(byQuery(params, grant))),
    postFails: (body, grant = all) => tagOf(served(byParameters(body, grant)))
  }
  try {
    await use(kit)
  } finally {
    connection.closeSync()
  }
}

const filled = async (store: Versioned): Promise<void> => {
  await put(store, { resourceType: "Patient", id: "p1" })
  await put(store, { resourceType: "Patient", id: "p2" })
  await put(store, document("d1", "p1", "2024-03-01T09:00:00Z"))
  await put(store, document("d2", "p1", "2024-05-01T09:00:00Z"))
  await put(store, document("d3", "p2", "2024-03-01T09:00:00Z"))
}

const held = (page: Page): ReadonlyArray<string> => page.entry.map((one) => String(one.fullUrl))

const tokenOf = (page: Page): string =>
  String(
    new URLSearchParams(
      String(page.link.find((one) => one.relation === "next")?.url).split("?")[1]
    ).get("_ct")
  )

describe("docref", () => {
  it("returns the documents of one patient", () =>
    withKit(async ({ store, get }) => {
      await filled(store)
      const page = await get([["patient", "p1"]])
      expect(held(page)).toEqual(["DocumentReference/d1", "DocumentReference/d2"])
    }))

  it("honours a window on the document date", () =>
    withKit(async ({ store, get }) => {
      await filled(store)
      expect(held(await get([["patient", "p1"], ["start", "2024-04-01"]]))).toEqual([
        "DocumentReference/d2"
      ])
      expect(held(await get([["patient", "p1"], ["end", "2024-04-01"]]))).toEqual([
        "DocumentReference/d1"
      ])
    }))

  it("reports a patient that is not held", () =>
    withKit(async ({ store, getFails }) => {
      await filled(store)
      expect(await getFails([["patient", "p9"]])).toBe("NotFound")
    }))

  it("refuses a request naming no patient", () =>
    withKit(async ({ getFails, postFails }) => {
      expect(await getFails([["start", "2024-01-01"]])).toBe("Rejected")
      expect(await postFails(parameters([{ name: "start", valueDateTime: "2024-01-01" }]))).toBe(
        "Rejected"
      )
    }))

  it("refuses a parameter it does not know", () =>
    withKit(async ({ getFails, postFails }) => {
      expect(await getFails([["patient", "p1"], ["colour", "blue"]])).toBe("Rejected")
      expect(
        await postFails(
          parameters([{ name: "patient", valueId: "p1" }, { name: "colour", valueString: "blue" }])
        )
      ).toBe("Rejected")
    }))

  it("refuses the same parameter given twice", () =>
    withKit(async ({ getFails }) => {
      expect(await getFails([["patient", "p1"], ["patient", "p2"]])).toBe("Rejected")
    }))

  it("refuses a body that is not a parameters resource", () =>
    withKit(async ({ postFails }) => {
      expect(await postFails({ resourceType: "Patient", id: "p1" })).toBe("Rejected")
      expect(await postFails("patient=p1")).toBe("Rejected")
      expect(await postFails({ resourceType: "Parameters" })).toBe("Rejected")
    }))

  it("refuses a parameter carrying no value", () =>
    withKit(async ({ postFails }) => {
      expect(await postFails(parameters([{ name: "patient" }]))).toBe("Rejected")
    }))

  it("refuses a page size that is not a number", () =>
    withKit(async ({ getFails }) => {
      expect(await getFails([["patient", "p1"], ["_count", "many"]])).toBe("Rejected")
    }))

  it("refuses a grant that does not reach the patient", () =>
    withKit(async ({ store, getFails }) => {
      await filled(store)
      expect(await getFails([["patient", "p1"]], { read: true, patients: ["p2"] })).toBe(
        "Forbidden"
      )
    }))

  it("refuses a grant that does not cover documents", () =>
    withKit(async ({ store, getFails }) => {
      await filled(store)
      expect(await getFails([["patient", "p1"]], { read: true, types: ["Patient"] })).toBe(
        "Forbidden"
      )
    }))
})

describe("docref, one answer for both forms", () => {
  it("answers a plain request the same way either way", () =>
    withKit(async ({ store, get, post }) => {
      await filled(store)
      const asked = await get([["patient", "p1"]])
      const posted = await post(parameters([{ name: "patient", valueId: "p1" }]))
      expect(posted).toEqual(asked)
    }))

  it("answers a narrowed request the same way either way", () =>
    withKit(async ({ store, get, post }) => {
      await filled(store)
      const asked = await get([
        ["patient", "p1"],
        ["start", "2024-01-01"],
        ["end", "2024-12-31"],
        ["_count", "1"]
      ])
      const posted = await post(
        parameters([
          { name: "patient", valueId: "p1" },
          { name: "start", valueDateTime: "2024-01-01" },
          { name: "end", valueDateTime: "2024-12-31" },
          { name: "_count", valueInteger: 1 }
        ])
      )
      expect(posted).toEqual(asked)
      expect(held(asked)).toEqual(["DocumentReference/d1"])
    }))

  it("answers the same way either way when the order given differs", () =>
    withKit(async ({ store, get, post }) => {
      await filled(store)
      const asked = await get([["end", "2024-12-31"], ["patient", "p1"]])
      const posted = await post(
        parameters([
          { name: "patient", valueString: "p1" },
          { name: "end", valueString: "2024-12-31" }
        ])
      )
      expect(posted).toEqual(asked)
    }))

  it("carries on from the same token either way", () =>
    withKit(async ({ store, get, post }) => {
      await filled(store)
      const first = await get([["patient", "p1"], ["_count", "1"]])
      expect(held(first)).toEqual(["DocumentReference/d1"])
      const ct = tokenOf(first)
      const asked = await get([["patient", "p1"], ["_count", "1"], ["_ct", ct]])
      const posted = await post(
        parameters([
          { name: "patient", valueId: "p1" },
          { name: "_count", valueInteger: 1 },
          { name: "_ct", valueString: ct }
        ])
      )
      expect(posted).toEqual(asked)
      expect(held(asked)).toEqual(["DocumentReference/d2"])
    }))

  it("refuses a token issued for another patient in either form", () =>
    withKit(async ({ store, get, getFails, postFails }) => {
      await filled(store)
      const ct = tokenOf(await get([["patient", "p1"], ["_count", "1"]]))
      expect(await getFails([["patient", "p2"], ["_count", "1"], ["_ct", ct]])).toBe("Rejected")
      expect(
        await postFails(
          parameters([
            { name: "patient", valueId: "p2" },
            { name: "_count", valueInteger: 1 },
            { name: "_ct", valueString: ct }
          ])
        )
      ).toBe("Rejected")
    }))
})

describe("docref, refused shapes", () => {
  it("refuses a parameter entry that is not a named parameter", () =>
    withKit(async ({ postFails }) => {
      expect(await postFails({ resourceType: "Parameters", parameter: ["patient"] })).toBe(
        "Rejected"
      )
    }))

  it("refuses a patient that is not a resource id", () =>
    withKit(async ({ getFails }) => {
      expect(await getFails([["patient", "not an id"]])).toBe("Rejected")
    }))

  it("reports a patient that was deleted", () =>
    withKit(async ({ store, getFails }) => {
      await filled(store)
      await Effect.runPromise(store.markDeleted("Patient", "p1", 2, "2024-06-01T00:00:00.000Z"))
      expect(await getFails([["patient", "p1"]])).toBe("Gone")
    }))
})
