import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Denial } from "./failure.js"
import { status } from "./failure.js"
import { clockAt } from "./ports.js"
import type { Clock } from "./ports.js"
import { count, register, registry } from "./registration.js"
import type { Policy, Registry, Request } from "./registration.js"

const NOW = 1_800_000_000

const policy: Policy = {
  software: ["clinic-desktop", "ward-tablet"],
  redirects: ["https://clinic.example"],
  max: 2
}

const request: Request = {
  software: "clinic-desktop",
  name: "Clinic desktop",
  redirects: ["https://clinic.example/callback"]
}

const at = <A>(effect: Effect.Effect<A, Denial, Clock>, seconds = NOW) =>
  Effect.runSyncExit(Effect.provide(effect, clockAt(seconds)))

const value = <A>(exit: Exit.Exit<A, Denial>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a value, got ${JSON.stringify(exit)}`)
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

const kept = (): Registry => registry()

describe("dynamic client registration, MCPA-03", () => {
  it("registers a client the configuration names", () => {
    const held = kept()
    const client = value(at(register(held, policy, request)))
    expect(client.software).toBe("clinic-desktop")
    expect(client.redirects).toEqual(["https://clinic.example/callback"])
    expect(client.registered).toBe(NOW)
    expect(count(held)).toBe(1)
  })

  it("gives every client a random identifier and no secret", () => {
    const held = kept()
    const one = value(at(register(held, policy, request)))
    const other = value(at(register(held, policy, { ...request, software: "ward-tablet" })))
    expect(one.id).not.toBe(other.id)
    expect(Buffer.from(one.id, "base64url")).toHaveLength(16)
    expect(one.method).toBe("none")
    expect(one.challenge).toBe("S256")
  })

  it("refuses a client the configuration does not name", () => {
    const refusal = denial(at(register(kept(), policy, { ...request, software: "unknown-agent" })))
    expect(status(refusal)).toBe(403)
    expect(refusal._tag).toBe("Forbidden")
  })

  it("refuses every client when the configuration names none", () => {
    const closed: Policy = { ...policy, software: [] }
    expect(status(denial(at(register(kept(), closed, request))))).toBe(400)
  })

  it("refuses a plain redirect address", () => {
    const refusal = denial(at(register(kept(), policy, {
      ...request,
      redirects: ["http://clinic.example/callback"]
    })))
    expect(status(refusal)).toBe(400)
  })

  it("accepts a loopback redirect address", () => {
    const client = value(at(register(kept(), policy, {
      ...request,
      redirects: ["http://127.0.0.1:7777/callback", "http://localhost:7777/callback"]
    })))
    expect(client.redirects).toHaveLength(2)
  })

  it("refuses a redirect at a host the configuration does not name", () => {
    expect(status(denial(at(register(kept(), policy, {
      ...request,
      redirects: ["https://elsewhere.example/callback"]
    }))))).toBe(400)
  })

  it("refuses a request with no redirect address", () => {
    expect(status(denial(at(register(kept(), policy, { ...request, redirects: [] })))))
      .toBe(400)
  })

  it("refuses text that is not an address", () => {
    expect(status(denial(at(register(kept(), policy, { ...request, redirects: ["callback"] })))))
      .toBe(400)
  })

  it("refuses once the configured number of clients is registered", () => {
    const held = kept()
    value(at(register(held, policy, request)))
    value(at(register(held, policy, { ...request, software: "ward-tablet" })))
    expect(status(denial(at(register(held, policy, request))))).toBe(400)
    expect(count(held)).toBe(2)
  })
})
