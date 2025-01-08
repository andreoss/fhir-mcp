import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { terminology } from "./terminology.js"

const system = (url: string) => ({
  resourceType: "CodeSystem",
  url,
  version: "1.0.0",
  content: "complete",
  concept: [{ code: "a", display: "Alpha" }, { code: "b", display: "Beta", parent: "a" }]
})

const withDir = async <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "term-"))
  try {
    return await use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("terminology in the composition root", () => {
  it("serves nothing loaded when no directory is configured", async () => {
    const sources = await Effect.runPromise(terminology(undefined))
    expect(sources.loaded ?? []).toEqual([])
  })

  it("loads every code system in the configured directory", async () =>
    withDir(async (dir) => {
      writeFileSync(join(dir, "a.json"), JSON.stringify(system("http://example/a")))
      writeFileSync(join(dir, "b.json"), JSON.stringify(system("http://example/b")))
      const sources = await Effect.runPromise(terminology(dir))
      expect((sources.loaded ?? []).map((s) => s.url).sort())
        .toEqual(["http://example/a", "http://example/b"])
    }))

  it("refuses to start on a directory holding an empty stand-in", async () =>
    withDir(async (dir) => {
      writeFileSync(
        join(dir, "empty.json"),
        JSON.stringify({ resourceType: "CodeSystem", url: "http://example/e", content: "complete" })
      )
      const exit = await Effect.runPromiseExit(terminology(dir))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it("reports a directory it cannot read rather than serving nothing quietly", async () => {
    const exit = await Effect.runPromiseExit(terminology("/does/not/exist/terms"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
