import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "./health.js"

const stateOf = (h: { checks: ReadonlyArray<{ name: string; state: string }> }, n: string) =>
  h.checks.find((c) => c.name === n)?.state

const withDir = async <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "health-"))
  try {
    return await use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("health command", () => {
  it("exercises the store rather than looking at a path", async () => {
    const found = await Effect.runPromise(inspect(":memory:", { FHIR_TRANSPORT: "stdio" }))
    expect(stateOf(found, "store")).toBe("up")
    expect(found.status).toBe("ok")
  })

  it("does not claim the engine is well when it never asked it", async () => {
    const found = await Effect.runPromise(inspect(":memory:", { FHIR_TRANSPORT: "stdio" }))
    expect(stateOf(found, "engine")).not.toBe("ok")
  })

  it("reports a store it cannot open as down, not as reachable", async () => {
    const found = await Effect.runPromise(
      inspect("/does/not/exist/nested/state.duckdb", { FHIR_TRANSPORT: "stdio" })
    )
    expect(stateOf(found, "store")).toBe("down")
    expect(found.status).toBe("failing")
  })

  it("reports a store file that is not a store as down", async () =>
    withDir(async (dir) => {
      const path = join(dir, "not-a-store.duckdb")
      writeFileSync(path, "this is not a database")
      const found = await Effect.runPromise(inspect(path, { FHIR_TRANSPORT: "stdio" }))
      expect(stateOf(found, "store")).toBe("down")
      expect(found.status).toBe("failing")
    }))

  it("opens a real store file and answers up", async () =>
    withDir(async (dir) => {
      const path = join(dir, "state.duckdb")
      const found = await Effect.runPromise(inspect(path, { FHIR_TRANSPORT: "stdio" }))
      expect(stateOf(found, "store")).toBe("up")
    }))

  it("reports a configuration it cannot accept", async () => {
    const found = await Effect.runPromise(inspect(":memory:", { FHIR_TRANSPORT: "pigeon" }))
    expect(stateOf(found, "config")).toContain("rejected")
    expect(found.status).toBe("failing")
  })
})
