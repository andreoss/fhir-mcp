import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock, clockAt, systemClock } from "./ports.js"

const now = Effect.gen(function* () {
  const clock = yield* Clock
  return clock.seconds()
})

describe("clock port", () => {
  it("hands back the time a test fixed", () => {
    expect(Effect.runSync(Effect.provide(now, clockAt(1000)))).toBe(1000)
  })

  it("reads whole seconds from the system when nothing fixed it", () => {
    const seconds = Effect.runSync(Effect.provide(now, systemClock))
    expect(Number.isInteger(seconds)).toBe(true)
    expect(seconds).toBeGreaterThan(1_700_000_000)
  })
})
