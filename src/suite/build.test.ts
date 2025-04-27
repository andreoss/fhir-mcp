import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compiler, defaultEntry, ensure, termsEntry } from "./build.js"

const scratch = () => mkdtemp(join(tmpdir(), "suite-build-"))

describe("build", () => {
  it("names the built entry point of this package by default", () => {
    expect(defaultEntry({})).toMatch(/dist[/\\]host[/\\]cli\.js$/)
  })

  it("lets an environment point the suite at another build", () => {
    expect(defaultEntry({ FHIR_SUITE_ENTRY: "/other/cli.js" })).toBe("/other/cli.js")
  })

  it("names the built entry that carries the terminology of this build", () => {
    expect(termsEntry({})).toMatch(/dist[/\\]suite[/\\]cli\.js$/)
  })

  it("lets an environment point the suite at another carrying build", () => {
    expect(termsEntry({ FHIR_SUITE_TERMS_ENTRY: "/other/terms.js" })).toBe("/other/terms.js")
  })

  it("uses an entry that is already there without compiling", async () => {
    const dir = await scratch()
    const entry = join(dir, "cli.js")
    await writeFile(entry, "", "utf8")
    let ran = 0
    const found = await ensure({
      entry,
      compile: async () => {
        ran += 1
      }
    })
    expect(found).toBe(entry)
    expect(ran).toBe(0)
    await rm(dir, { recursive: true, force: true })
  })

  it("compiles once when the entry is absent", async () => {
    const dir = await scratch()
    const entry = join(dir, "cli.js")
    let ran = 0
    const found = await ensure({
      entry,
      lock: join(dir, "lock"),
      compile: async () => {
        ran += 1
        await writeFile(entry, "", "utf8")
      }
    })
    expect(found).toBe(entry)
    expect(ran).toBe(1)
    await rm(dir, { recursive: true, force: true })
  })

  it("waits for the build another runner holds rather than racing it", async () => {
    const dir = await scratch()
    const entry = join(dir, "cli.js")
    const lock = join(dir, "lock")
    await mkdir(lock)
    setTimeout(() => {
      void writeFile(entry, "", "utf8")
    }, 60)
    const found = await ensure({
      entry,
      lock,
      budget: 5000,
      compile: async () => {
        throw new Error("compiled while another runner held the lock")
      }
    })
    expect(found).toBe(entry)
    await rm(dir, { recursive: true, force: true })
  })

  it("bounds the wait and says which entry never arrived", async () => {
    const dir = await scratch()
    const entry = join(dir, "cli.js")
    const lock = join(dir, "lock")
    await mkdir(lock)
    await expect(
      ensure({ entry, lock, budget: 120, compile: async () => {} })
    ).rejects.toThrow(entry)
    await rm(dir, { recursive: true, force: true })
  })

  it("frees the lock when compiling fails", async () => {
    const dir = await scratch()
    const entry = join(dir, "cli.js")
    const lock = join(dir, "lock")
    await expect(
      ensure({
        entry,
        lock,
        compile: async () => {
          throw new Error("compiler refused")
        }
      })
    ).rejects.toThrow("compiler refused")
    const second = await ensure({
      entry,
      lock,
      compile: async () => {
        await writeFile(entry, "", "utf8")
      }
    })
    expect(second).toBe(entry)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("the compiler the build reaches for", () => {
  it("settles when the compiler is content", async () => {
    const dir = await scratch()
    const bin = join(dir, "ok.mjs")
    await writeFile(bin, "process.exit(0)\n", "utf8")
    await expect(compiler(bin, dir)()).resolves.toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it("says what the compiler answered when it refuses", async () => {
    const dir = await scratch()
    const bin = join(dir, "bad.mjs")
    await writeFile(bin, "process.exit(3)\n", "utf8")
    await expect(compiler(bin, dir)()).rejects.toThrow("build refused: 3")
    await rm(dir, { recursive: true, force: true })
  })

  it("reports a compiler that cannot be started at all", async () => {
    const dir = await scratch()
    const bin = join(dir, "ok.mjs")
    await rm(dir, { recursive: true, force: true })
    await expect(compiler(bin, join(dir, "gone"))()).rejects.toThrow()
  })
})

describe("build defaults", () => {
  it("takes its own lock and wait when none are named", async () => {
    const dir = await scratch()
    const entry = join(dir, "cli.js")
    const found = await ensure({
      entry,
      compile: async () => {
        await writeFile(entry, "", "utf8")
      }
    })
    expect(found).toBe(entry)
    await rm(dir, { recursive: true, force: true })
  })
})
