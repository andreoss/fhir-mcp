import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Refused, guard } from "./guard.js"

describe("guard", () => {
  it("lets a harmless run through", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(guard(false, false, "rebuild the index")))).toBe(true)
  })

  it("lets a destructive run through once the flag is given", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(guard(true, true, "rebuild the index")))).toBe(true)
  })

  it("refuses a destructive run without the flag", () => {
    const exit = Effect.runSyncExit(guard(true, false, "rebuild the index"))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error.message).toBe("refusing to rebuild the index without --force")
  })

  it("names the action it refused", () => {
    expect(new Refused({ action: "drop history" }).action).toBe("drop history")
  })
})
