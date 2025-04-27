import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { key } from "./model.js"
import type { Definition, Entry, Snapshot, Status } from "./model.js"
import { admit } from "./gate.js"

const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const reason = async <A, E>(effect: Effect.Effect<A, E>): Promise<string> => {
  const result = await exit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    const held = result.cause.error as { readonly _tag: string; readonly reason?: string }
    expect(held._tag).toBe("Rejected")
    return held.reason ?? ""
  }
  throw new Error("expected a refusal")
}

const shape = (
  type: string,
  name: string,
  valueType: Definition["valueType"],
  targets: ReadonlyArray<string> = []
): Definition => ({ type, name, valueType, path: [name], targets, components: [] })

const entry = (definition: Definition, status: Status): Entry => ({
  definition,
  status,
  version: 1,
  done: 0,
  total: 0,
  failures: 0,
  updatedAt: "1970-01-01T00:00:00.000Z"
})

const held: Snapshot = {
  epoch: 3,
  entries: new Map(
    [
      entry(shape("Patient", "family", "string"), "active"),
      entry(shape("Patient", "nickname", "token"), "draft"),
      entry(shape("Observation", "code", "token"), "backfilling"),
      entry(shape("Observation", "subject", "reference", ["Patient"]), "active"),
      entry(shape("Observation", "performer", "reference", ["Doctor", "Clinic"]), "active"),
      entry(shape("Observation", "value", "number"), "active")
    ].map((one) => [key(one), one] as const)
  )
}

describe("search parameter gate", () => {
  it("admits a parameter whose index is in force", async () => {
    expect(await exit(admit(held, "Patient", [["family", "Simpson"]]))).toSatisfy(
      Exit.isSuccess
    )
  })

  it("admits a modifier on a parameter in force", async () => {
    expect(await exit(admit(held, "Patient", [["family:exact", "Simpson"]]))).toSatisfy(
      Exit.isSuccess
    )
  })

  it("refuses a parameter it does not know", async () => {
    expect(await reason(admit(held, "Patient", [["shoesize", "9"]]))).toContain(
      "unknown search parameter"
    )
  })

  it("refuses a parameter whose backfill has not finished", async () => {
    const said = await reason(admit(held, "Patient", [["nickname", "bess"]]))
    expect(said).toContain("not ready")
    expect(said).toContain("Patient.nickname")
    expect(said).toContain("draft")
  })

  it("lets a control parameter through untouched", async () => {
    expect(
      await exit(admit(held, "Patient", [["_count", "10"], ["_sort", "family"]]))
    ).toSatisfy(Exit.isSuccess)
  })

  it("refuses a not-ready parameter reached through a chain", async () => {
    expect(await reason(admit(held, "Observation", [["subject.nickname", "bess"]]))).toContain(
      "not ready"
    )
  })

  it("admits a parameter in force reached through a chain", async () => {
    expect(
      await exit(admit(held, "Observation", [["subject.family", "Simpson"]]))
    ).toSatisfy(Exit.isSuccess)
  })

  it("admits a chain whose target type is named", async () => {
    expect(
      await exit(admit(held, "Observation", [["subject:Patient.family", "Simpson"]]))
    ).toSatisfy(Exit.isSuccess)
  })

  it("refuses a chain through a parameter that is not a reference", async () => {
    expect(await reason(admit(held, "Patient", [["family.given", "Bart"]]))).toContain(
      "not a reference"
    )
  })

  it("refuses a chain whose target type is ambiguous", async () => {
    expect(
      await reason(admit(held, "Observation", [["performer.family", "Simpson"]]))
    ).toContain("ambiguous")
  })

  it("refuses a not-ready parameter reached backwards", async () => {
    expect(
      await reason(admit(held, "Patient", [["_has:Observation:subject:code", "1234"]]))
    ).toContain("not ready")
  })

  it("refuses a backwards reference that is malformed", async () => {
    expect(await reason(admit(held, "Patient", [["_has:Observation", "1234"]]))).toContain(
      "_has:Type:reference:parameter"
    )
  })

  it("refuses a backwards link that is not a reference", async () => {
    expect(
      await reason(admit(held, "Patient", [["_has:Observation:value:code", "1234"]]))
    ).toContain("not a reference")
  })

  it("refuses a backwards reference through an unknown link", async () => {
    expect(
      await reason(admit(held, "Patient", [["_has:Observation:owner:code", "1234"]]))
    ).toContain("unknown search parameter")
  })
})
