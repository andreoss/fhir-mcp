import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { grant } from "../auth/scope.js"
import { manager } from "../compartment/definition.js"
import type { Manager } from "../compartment/definition.js"
import { UNRESTRICTED, fingerprint, granted, limits, sound } from "./restriction.js"
import type { Restriction } from "./restriction.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const held = (): Promise<Manager> => run(manager())

const READ = { action: "read", type: "Observation" } as const

const forged = { name: "unrestricted", grant: undefined } as unknown as Restriction

describe("a restriction is named, never assumed", () => {
  it("names the unrestricted one", () => {
    expect(UNRESTRICTED.name).toBe("unrestricted")
    expect(UNRESTRICTED.grant).toBeUndefined()
  })

  it("names a granted one and keeps the grant", () => {
    const one = granted(grant(["patient:p1/*.read"]))
    expect(one.name).toBe("granted")
    expect(one.grant?.scopes).toHaveLength(1)
  })

  it("accepts only a restriction it issued", () => {
    expect(sound(UNRESTRICTED)).toBe(true)
    expect(sound(granted(grant(["patient:p1/*.read"])))).toBe(true)
    expect(sound(forged)).toBe(false)
  })
})

describe("limits come from the restriction alone", () => {
  it("imposes none for the named unrestricted one", async () => {
    expect(await run(limits(UNRESTRICTED, await held(), READ))).toEqual([])
  })

  it("imposes the compartment a grant names", async () => {
    const found = await run(
      limits(granted(grant(["patient:p1/*.read"])), await held(), READ)
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.ids).toEqual(["p1"])
    expect(found[0]?.definition.resource).toBe("Patient")
  })

  it("imposes none when the grant names no compartment", async () => {
    expect(await run(limits(granted(grant(["system/*.read"])), await held(), READ)))
      .toEqual([])
  })

  it("refuses a grant that does not cover the type", async () => {
    const result = await exit(
      limits(granted(grant(["user/Patient.read"])), await held(), READ)
    )
    expect(Exit.isFailure(result)).toBe(true)
  })

  it("refuses a look-alike that was never issued", async () => {
    const result = await exit(limits(forged, await held(), READ))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      expect(result.cause.error._tag).toBe("Forbidden")
    }
  })

  it("refuses a compartment kind it cannot enforce", async () => {
    const result = await exit(
      limits(granted(grant(["user:e1/*.read"])), await held(), READ)
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      expect(result.cause.error._tag).toBe("Rejected")
    }
  })
})

describe("a fingerprint separates one grant from another", () => {
  it("gives two grants two fingerprints", () => {
    expect(fingerprint(granted(grant(["patient:p1/*.read"]))))
      .not.toBe(fingerprint(granted(grant(["patient:p2/*.read"]))))
  })

  it("gives the same grant the same fingerprint", () => {
    expect(fingerprint(granted(grant(["patient:p1/*.read"]))))
      .toBe(fingerprint(granted(grant(["patient:p1/*.read"]))))
  })

  it("separates a grant from the unrestricted one", () => {
    expect(fingerprint(UNRESTRICTED))
      .not.toBe(fingerprint(granted(grant(["system/*.read"]))))
  })
})
