import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { BUILT_IN, ENCOUNTER, PATIENT, manager, validate } from "./definition.js"
import type { Definition } from "./definition.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const VISIT: Definition = {
  code: "visit",
  resource: "Encounter",
  types: {
    Encounter: { own: true, params: [] },
    Observation: { own: false, params: ["encounter"] }
  }
}

describe("compartment definitions", () => {
  it("places an observation in the patient compartment by subject and performer", () => {
    expect(PATIENT.types["Observation"]).toEqual({
      own: false,
      params: ["subject", "performer"]
    })
  })

  it("places the patient itself in its own compartment", () => {
    expect(PATIENT.types["Patient"]).toEqual({ own: true, params: [] })
  })

  it("covers the four served types", () => {
    expect(Object.keys(PATIENT.types).sort()).toEqual([
      "Condition",
      "Encounter",
      "Observation",
      "Patient"
    ])
  })

  it("names the resource each compartment is anchored on", () => {
    expect(PATIENT.resource).toBe("Patient")
    expect(ENCOUNTER.resource).toBe("Encounter")
    expect(ENCOUNTER.types["Observation"]?.params).toEqual(["encounter"])
  })

  it("accepts every built-in definition", async () => {
    for (const one of BUILT_IN) {
      expect((await run(validate(one))).code).toBe(one.code)
    }
  })

  it("refuses a code that is not a name", async () => {
    expect(tag(await exit(validate({ ...PATIENT, code: "Patient Compartment" }))))
      .toBe("Rejected")
  })

  it("refuses a definition that does not place its own resource", async () => {
    expect(
      tag(
        await exit(
          validate({
            code: "patient",
            resource: "Patient",
            types: { Observation: { own: false, params: ["subject"] } }
          })
        )
      )
    ).toBe("Rejected")
  })

  it("refuses ownership claimed by another resource", async () => {
    expect(
      tag(
        await exit(
          validate({
            ...PATIENT,
            types: {
              ...PATIENT.types,
              Observation: { own: true, params: [] }
            }
          })
        )
      )
    ).toBe("Rejected")
  })

  it("refuses a placed type that names no parameter", async () => {
    expect(
      tag(
        await exit(
          validate({
            ...PATIENT,
            types: { ...PATIENT.types, Observation: { own: false, params: [] } }
          })
        )
      )
    ).toBe("Rejected")
  })

  it("refuses a type that is not served", async () => {
    expect(
      tag(
        await exit(
          validate({
            ...PATIENT,
            types: { ...PATIENT.types, Medication: { own: false, params: ["subject"] } }
          })
        )
      )
    ).toBe("Rejected")
  })
})

describe("compartment definitions are managed at runtime", () => {
  it("answers with a built-in definition", async () => {
    const held = await run(manager())
    expect((await run(held.get("patient"))).resource).toBe("Patient")
    expect(await run(held.codes())).toEqual(["patient", "encounter"])
  })

  it("refuses an unknown code", async () => {
    const held = await run(manager())
    expect(tag(await exit(held.get("device")))).toBe("Rejected")
  })

  it("adds a definition after start", async () => {
    const held = await run(manager())
    await run(held.put(VISIT))
    expect((await run(held.get("visit"))).types["Observation"]?.params).toEqual([
      "encounter"
    ])
    expect(await run(held.codes())).toContain("visit")
  })

  it("changes a definition after start", async () => {
    const held = await run(manager())
    await run(
      held.put({
        ...PATIENT,
        types: { ...PATIENT.types, Observation: { own: false, params: ["patient"] } }
      })
    )
    expect((await run(held.get("patient"))).types["Observation"]?.params).toEqual([
      "patient"
    ])
  })

  it("drops a definition after start", async () => {
    const held = await run(manager())
    await run(held.drop("encounter"))
    expect(await run(held.codes())).toEqual(["patient"])
    expect(tag(await exit(held.drop("encounter")))).toBe("Rejected")
  })

  it("refuses an invalid definition at start and at put", async () => {
    expect(tag(await exit(manager([{ ...PATIENT, code: "" }])))).toBe("Rejected")
    const held = await run(manager())
    expect(tag(await exit(held.put({ ...VISIT, code: "" })))).toBe("Rejected")
  })
})

describe("a compartment that does not own its anchor", () => {
  it("is refused when the anchor is not served", async () => {
    expect(tag(await exit(validate({ ...PATIENT, resource: "Medication" }))))
      .toBe("Rejected")
  })

  it("is refused", async () => {
    expect(
      tag(
        await exit(
          validate({
            ...PATIENT,
            types: {
              ...PATIENT.types,
              Patient: { own: false, params: ["link"] }
            }
          })
        )
      )
    ).toBe("Rejected")
  })
})
