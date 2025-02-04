import { describe, expect, it } from "vitest"
import { Effect, Either, Exit } from "effect"
import {
  FIVE,
  FOUR,
  GENERATED,
  VERSIONS,
  modelsOf,
  names,
  versionOf
} from "./catalog.js"
import {
  compartmentIn,
  definitionIn,
  hasType,
  paramIn,
  paramsIn
} from "./version.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const reason = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { readonly reason: string }).reason
  }
  throw new Error("expected a failure")
}

describe("every named version is served, not only the default", () => {
  it("names both versions it carries", () => {
    expect(names()).toEqual(["4.0.1", "5.0.0"])
    expect(VERSIONS.length).toBe(2)
  })

  it("resolves each named version to its own model", async () => {
    expect((await run(versionOf("4.0.1"))).name).toBe("4.0.1")
    expect((await run(versionOf("5.0.0"))).name).toBe("5.0.0")
  })

  it("resolves a version other than the default", async () => {
    const held = await run(versionOf("5.0.0"))
    expect(held).not.toBe(VERSIONS[0])
    expect(held).toBe(FIVE)
  })

  it("refuses an unserved version, naming it", async () => {
    expect(reason(await exit(versionOf("3.0.2")))).toBe(
      "3.0.2 is not a served version"
    )
  })

  it("resolves against a catalog given to it", async () => {
    expect((await run(versionOf("5.0.0", [FIVE]))).name).toBe("5.0.0")
    expect(names([FOUR])).toEqual(["4.0.1"])
  })
})

describe("two versions carry different type lists", () => {
  it("serves a type in the earlier version that the later one drops",
    async () => {
      expect(hasType(FOUR, "Encounter")).toBe(true)
      expect(hasType(FIVE, "Encounter")).toBe(false)
      expect(reason(await exit(definitionIn(FIVE, "Encounter")))).toBe(
        "Encounter is not served in 5.0.0"
      )
    })

  it("serves a type in the later version that the earlier one lacks",
    async () => {
      expect(hasType(FIVE, "Procedure")).toBe(true)
      expect(hasType(FOUR, "Procedure")).toBe(false)
      expect(reason(await exit(definitionIn(FOUR, "Procedure")))).toBe(
        "Procedure is not served in 4.0.1"
      )
    })

  it("lists different types for each version", () => {
    expect(FOUR.types).toEqual([
      "Condition",
      "Encounter",
      "Observation",
      "Patient"
    ])
    expect(FIVE.types).toEqual([
      "Condition",
      "Observation",
      "Patient",
      "Procedure"
    ])
  })
})

describe("two versions carry different element definitions", () => {
  it("adds an element to a shared type in the later version", async () => {
    const later = await run(definitionIn(FIVE, "Observation"))
    const earlier = await run(definitionIn(FOUR, "Observation"))
    expect(later.elements["instantiatesCanonical"]).toEqual({
      kind: "uri",
      card: "0..1"
    })
    expect(earlier.elements["instantiatesCanonical"]).toBeUndefined()
  })

  it("keeps the elements the two versions share", async () => {
    const later = await run(definitionIn(FIVE, "Observation"))
    const earlier = await run(definitionIn(FOUR, "Observation"))
    expect(later.elements["status"]).toEqual(earlier.elements["status"])
  })

  it("models the type only the later version serves", async () => {
    const held = await run(definitionIn(FIVE, "Procedure"))
    expect(held.type).toBe("Procedure")
    expect(held.elements["status"]).toEqual({ kind: "code", card: "1..1" })
    expect(held.elements["occurrenceDateTime"]).toEqual({
      kind: "dateTime",
      card: "0..1"
    })
    expect(held.elements["occurrencePeriod"]?.kind).toBe("group")
    expect(held.elements["performer"]?.kind).toBe("group")
  })

  it("emitted that type from specification-shaped input", () => {
    expect(Either.isRight(GENERATED)).toBe(true)
    expect(Object.keys(modelsOf(GENERATED))).toEqual(["Procedure"])
  })

  it("holds no model at all when the emission is refused", () => {
    expect(modelsOf(Either.left("refused"))).toEqual({})
  })
})

describe("two versions carry different search parameters", () => {
  it("admits a parameter in the earlier version and refuses it later",
    async () => {
      expect(await run(paramIn(FOUR, "Condition", "clinicalstatus"))).toEqual({
        path: ["clinicalStatus", "coding", "code"]
      })
      expect(reason(await exit(paramIn(FIVE, "Condition", "clinicalstatus"))))
        .toBe("clinicalstatus is not a search parameter of Condition in 5.0.0")
    })

  it("admits the renamed parameter in the later version only", async () => {
    expect(await run(paramIn(FIVE, "Condition", "clinical-status"))).toEqual({
      path: ["clinicalStatus", "coding", "code"]
    })
    expect(reason(await exit(paramIn(FOUR, "Condition", "clinical-status"))))
      .toBe("clinical-status is not a search parameter of Condition in 4.0.1")
  })

  it("declares parameters for the type only the later version serves",
    async () => {
      expect(Object.keys(await run(paramsIn(FIVE, "Procedure"))).sort())
        .toEqual(["_id", "code", "status", "subject"])
    })

  it("carries the common parameters in both versions", async () => {
    expect((await run(paramsIn(FOUR, "Patient")))["_id"]).toEqual({
      path: ["id"]
    })
    expect((await run(paramsIn(FIVE, "Patient")))["_id"]).toEqual({
      path: ["id"]
    })
  })

  it("keeps the parameter lists of the two versions distinct", async () => {
    const earlier = Object.keys(await run(paramsIn(FOUR, "Condition"))).sort()
    const later = Object.keys(await run(paramsIn(FIVE, "Condition"))).sort()
    expect(earlier).not.toEqual(later)
  })
})

describe("two versions carry different compartment definitions", () => {
  it("anchors a compartment on a type the later version dropped", async () => {
    expect((await run(compartmentIn(FOUR, "encounter"))).resource).toBe(
      "Encounter"
    )
    expect(reason(await exit(compartmentIn(FIVE, "encounter")))).toBe(
      "encounter is not a compartment in 5.0.0"
    )
  })

  it("places only the types each version serves", async () => {
    const earlier = await run(compartmentIn(FOUR, "patient"))
    const later = await run(compartmentIn(FIVE, "patient"))
    expect(Object.keys(earlier.types)).toContain("Encounter")
    expect(Object.keys(later.types)).not.toContain("Encounter")
    expect(later.types["Procedure"]).toEqual({
      own: false,
      params: ["subject", "performer"]
    })
  })

  it("places every compartment type within the version that holds it", () => {
    for (const version of VERSIONS) {
      for (const held of version.compartments) {
        for (const type of Object.keys(held.types)) {
          expect(hasType(version, type)).toBe(true)
        }
      }
    }
  })
})
