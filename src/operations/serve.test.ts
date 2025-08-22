import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Version } from "../core/interactions.js"
import type { FhirResource } from "../core/engine.js"
import type { Failure } from "../core/outcome.js"
import type { Restriction } from "../engine/restriction.js"
import { UNRESTRICTED, granted } from "../engine/restriction.js"
import { grant } from "../auth/scope.js"
import type { Found, Reader, Window } from "./records.js"
import { Records } from "./records.js"
import type { Grant } from "./grant.js"
import type { Page } from "./page.js"
import { invoke, operationsOn, permissionOf } from "./serve.js"

const OP = "$everything"

const all: Grant = { read: true }

const at = (type: string, id: string): Version => ({
  type,
  id,
  versionId: 1,
  lastUpdated: "2024-01-01T00:00:00.000Z",
  deleted: false,
  body: { resourceType: type, id } as FhirResource
})

interface Seen {
  readonly patient: string
  readonly types: ReadonlyArray<string>
  readonly window: Window
  readonly slice: { readonly offset: number; readonly limit: number }
}

const reader = (
  held: ReadonlyArray<Version>,
  patient: Version | undefined = undefined,
  seen: Array<Seen> = []
): Reader => ({
  get: (type, id) =>
    Effect.succeed(
      patient !== undefined && type === patient.type && id === patient.id ? patient : undefined
    ),
  compartment: (of, types, window, slice) => {
    seen.push({ patient: of, types, window, slice })
    return Effect.succeed<Found>({
      total: held.length,
      of: held.filter((one) => types.includes(one.type)).slice(slice.offset, slice.offset + slice.limit)
    })
  },
  byIdentifier: () => Effect.succeed([])
})

const run = <A>(
  effect: Effect.Effect<A, Failure, Records>,
  held: ReadonlyArray<Version> = [],
  patient: Version | undefined = at("Patient", "p1"),
  seen: Array<Seen> = []
): Promise<A> =>
  Effect.runPromise(Effect.provideService(effect, Records, reader(held, patient, seen)))

const refused = async (
  effect: Effect.Effect<unknown, Failure, Records>
): Promise<string> => {
  const exit = await Effect.runPromiseExit(
    Effect.provideService(effect, Records, reader([], undefined))
  )
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    const error = exit.cause.error as { _tag: string; reason?: string; action?: string }
    return error._tag === "Forbidden"
      ? `forbidden: ${error.action ?? ""}`
      : (error.reason ?? "")
  }
  throw new Error("expected a refusal")
}

const asked = (parameters: ReadonlyArray<readonly [string, string]>, id?: string) => ({
  name: OP,
  type: "Patient",
  ...(id === undefined ? {} : { id }),
  parameters
})

describe("EVR-01 the operations door answers an operation by name", () => {
  it("reads the compartment of the patient the read named", async () => {
    const seen: Array<Seen> = []
    const found = await run(
      invoke(asked([], "p1"), all),
      [at("Observation", "o1")],
      at("Patient", "p1"),
      seen
    )
    expect(found.resourceType).toBe("Bundle")
    expect(found.type).toBe("searchset")
    expect(found.total).toBe(1)
    expect(found.entry?.map((one) => one.resource["id"])).toEqual(["o1"])
    expect(seen[0]?.patient).toBe("p1")
  })

  it("answers an empty compartment as a bundle of no entries", async () => {
    const found = await run(invoke(asked([], "p1"), all))
    expect(found.total).toBe(0)
    expect(found.entry).toEqual([])
  })

  it("carries the window and the types the caller asked for", async () => {
    const seen: Array<Seen> = []
    await run(
      invoke(
        asked([
          ["_since", "2024-01-01"],
          ["_till", "2024-02-01"],
          ["_type", "Observation,Condition"],
          ["_count", "10"]
        ], "p1"),
        all
      ),
      [],
      at("Patient", "p1"),
      seen
    )
    expect(seen[0]?.types).toEqual(["Observation", "Condition"])
    expect(seen[0]?.window).toEqual({
      since: "2024-01-01T00:00:00.000Z",
      till: "2024-02-01T23:59:59.999Z"
    })
    expect(seen[0]?.slice.limit).toBe(10)
  })

  it("follows the continuation token the operation issued", async () => {
    const seen: Array<Seen> = []
    const first = (await run(
      invoke(asked([["_count", "1"]], "p1"), all),
      [at("Observation", "o1"), at("Observation", "o2")],
      at("Patient", "p1"),
      seen
    )) as Page
    const next = first.link?.find((one) => one.relation === "next")?.url ?? ""
    const token = new URL(next, "http://served").searchParams.get("_ct") ?? ""
    await run(
      invoke(asked([["_count", "1"], ["_ct", token]], "p1"), all),
      [at("Observation", "o2")],
      at("Patient", "p1"),
      seen
    )
    expect(seen[1]?.slice.offset).toBe(1)
  })

  it("refuses a parameter the operation does not take", async () => {
    expect(await refused(invoke(asked([["_filter", "x"], ], "p1"), all))).toBe(
      `${OP} does not take _filter`
    )
  })

  it("refuses a parameter given twice", async () => {
    expect(
      await refused(
        invoke(
          asked([
            ["_since", "2024-01-01"],
            ["_since", "2024-02-01"]
          ], "p1"),
          all
        )
      )
    ).toBe(`${OP} takes one _since`)
  })

  it("refuses a call that names no patient", async () => {
    expect(await refused(invoke(asked([]), all))).toBe(`${OP} needs a patient`)
  })

  it("refuses a name no operation answers to", async () => {
    expect(await refused(invoke({ name: "$nope", type: "Patient", parameters: [] }, all))).toBe(
      "no operation named $nope"
    )
  })

  it("refuses a patient the grant does not reach", async () => {
    const held: Grant = { read: true, patients: ["p2"] }
    expect(await refused(invoke(asked([], "p1"), held))).toBe(
      "forbidden: $everything of Patient/p1"
    )
  })
})

describe("EVR-01 the door takes its permission from the served restriction", () => {
  const of = (restriction: Restriction): Grant => permissionOf(restriction)

  it("leaves an unrestricted build unrestricted", () => {
    expect(of(UNRESTRICTED)).toEqual({ read: true })
  })

  it("keeps the types a scoped build may read", () => {
    expect(of(granted(grant(["user/Observation.read", "user/Condition.read"])))).toEqual({
      read: true,
      types: ["Observation", "Condition"]
    })
  })

  it("keeps the patients a compartment scope may read", () => {
    expect(of(granted(grant(["patient:p1/Observation.read"])))).toEqual({
      read: true,
      types: ["Observation"],
      patients: ["p1"]
    })
  })

  it("drops a type list when one scope names every type", () => {
    expect(of(granted(grant(["user/*.read"])))).toEqual({ read: true })
  })

  it("refuses to read when no scope allows it", () => {
    expect(of(granted(grant(["user/Observation.write"])))).toEqual({ read: false })
  })
})

describe("EVR-01 the port the composition root binds answers without a reader", () => {
  it("answers the compartment of the patient it was asked about", async () => {
    const found = await Effect.runPromise(
      operationsOn(reader([at("Observation", "o1")], at("Patient", "p1")), all).invoke(
        asked([], "p1")
      )
    )
    expect(found.type).toBe("searchset")
    expect(found.entry?.map((one) => one.resource["id"])).toEqual(["o1"])
  })

  it("refuses a name no operation answers to on the same port", async () => {
    const exit = await Effect.runPromiseExit(
      operationsOn(reader([]), all).invoke({ name: "$nope", type: "Patient", parameters: [] })
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
