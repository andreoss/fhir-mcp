import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exists, listNames, readText, writeText } from "./io.js"

const scratch = () => mkdtemp(join(tmpdir(), "tools-io-"))

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("io", () => {
  it("writes a file and reads it back", async () => {
    const dir = await scratch()
    const path = join(dir, "nested", "a.txt")
    await run(writeText(path, "body"))
    expect(await run(readText(path))).toBe("body")
    expect(await readFile(path, "utf8")).toBe("body")
  })

  it("says whether a path is there", async () => {
    const dir = await scratch()
    expect(await run(exists(join(dir, "missing")))).toBe(false)
    await run(writeText(join(dir, "there"), "x"))
    expect(await run(exists(join(dir, "there")))).toBe(true)
  })

  it("lists the names in a directory", async () => {
    const dir = await scratch()
    await run(writeText(join(dir, "b.ts"), "x"))
    await run(writeText(join(dir, "a.ts"), "x"))
    expect(await run(listNames(dir))).toEqual(["a.ts", "b.ts"])
  })

  it("lists nothing for a directory that is not there", async () => {
    const dir = await scratch()
    expect(await run(listNames(join(dir, "absent")))).toEqual([])
  })

  it("says which path could not be read", async () => {
    const dir = await scratch()
    const exit = await Effect.runPromiseExit(readText(join(dir, "absent.txt")))
    if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") throw new Error("expected failure")
    expect(exit.cause.error._tag).toBe("Rejected")
    expect((exit.cause.error as { reason: string }).reason).toContain("absent.txt")
  })
})
