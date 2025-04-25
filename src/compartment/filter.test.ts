import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { parse } from "../search/parse.js"
import { PATIENT } from "./definition.js"
import { inside, member, restricted } from "./filter.js"
import type { Limit } from "./filter.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const patient = (...ids: ReadonlyArray<string>): Limit => ({
  definition: PATIENT,
  ids
})

describe("membership of a compartment", () => {
  it("places nothing when the compartment names no identifier", () => {
    expect(member(patient(), "Observation")).toEqual({
      kind: "missing",
      type: "Observation",
      param: "_id",
      present: false
    })
  })

  it("places nothing of a type the definition leaves out", () => {
    expect(
      member(
        { definition: { ...PATIENT, types: {} }, ids: ["p1"] },
        "Observation"
      ).kind
    ).toBe("missing")
  })

  it("asks for the resource itself on the anchor type", () => {
    const found = member(patient("p1"), "Patient")
    expect(found.kind).toBe("compare")
    expect(found.kind === "compare" ? found.param : "").toBe("_id")
  })

  it("asks for every naming parameter on a placed type", () => {
    const found = member(patient("p1"), "Observation")
    expect(found.kind).toBe("or")
  })
})

describe("the restriction on a parsed query", () => {
  it("leaves a query alone when nothing restricts it", async () => {
    const query = await run(parse("Observation", [["code", "vital"]]))
    expect(restricted(query, [])).toBe(query)
  })

  it("keeps the terms a query already carries", async () => {
    const query = await run(parse("Observation", [["code", "vital"]]))
    const bound = restricted(query, [patient("p1")])
    expect(bound.expr?.kind).toBe("and")
    expect(bound.type).toBe("Observation")
  })
})

describe("the restriction on a joined row", () => {
  it("holds nothing back when no compartment is named", () => {
    expect(inside([], "t", "k")).toEqual({ sql: "true", values: [] })
  })

  it("holds everything back when no identifier is named", () => {
    expect(inside([patient()], "t", "k").sql).toBe("false")
  })

  it("binds every identifier it names", () => {
    const found = inside([patient("p1", "p2")], "t", "k")
    expect(found.sql).toContain("k0.target_id = ?")
    expect(found.sql).not.toContain("p1")
    expect(found.values).toContain("p1")
    expect(found.values).toContain("p2")
  })
})
