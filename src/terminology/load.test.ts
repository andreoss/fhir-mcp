import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TerminologyFiles, load, nodeFiles, parse } from "./load.js"
import type { Files } from "./load.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const reason = async <A>(effect: Effect.Effect<A, { readonly _tag: string }>): Promise<string> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    const failure = result.cause.error as { readonly _tag: string; readonly reason?: string }
    return `${failure._tag}: ${failure.reason ?? ""}`
  }
  throw new Error("expected a refusal")
}

const system = {
  resourceType: "CodeSystem",
  url: "http://example.test/animals",
  version: "1",
  content: "complete",
  concept: [
    {
      code: "animal",
      display: "Animal",
      concept: [
        {
          code: "cat",
          display: "Cat",
          designation: [{ language: "de", use: "display", value: "Katze" }]
        },
        { code: "dog", display: "Dog", property: [{ code: "inactive", valueBoolean: true }] },
        { code: "fox", display: "Fox", property: [{ code: "status", valueCode: "retired" }] }
      ]
    }
  ]
}

const memory = (entries: Record<string, string>): Files => ({
  list: () => Effect.succeed(Object.keys(entries).sort()),
  read: (path) =>
    Effect.succeed(entries[path] ?? "")
})

const layerOf = (entries: Record<string, string>) =>
  Layer.succeed(TerminologyFiles, memory(entries))

describe("reading a supplied file", () => {
  it("reads one code system, flattening the hierarchy into parent links", async () => {
    const [read] = await run(parse("a.json", JSON.stringify(system)))
    expect(read?.url).toBe("http://example.test/animals")
    expect(read?.version).toBe("1")
    expect(read?.content).toBe("complete")
    expect(read?.concept.map((c) => c.code)).toEqual(["animal", "cat", "dog", "fox"])
    expect(read?.concept[1]?.parent).toBe("animal")
    expect(read?.concept[0]?.parent).toBeUndefined()
  })

  it("carries the designations and the inactive concepts through", async () => {
    const [read] = await run(parse("a.json", JSON.stringify(system)))
    expect(read?.concept[1]?.designation).toEqual([
      { language: "de", use: "display", value: "Katze" }
    ])
    expect(read?.concept[1]?.inactive).toBeUndefined()
    expect(read?.concept[2]?.inactive).toBe(true)
    expect(read?.concept[3]?.inactive).toBe(true)
  })

  it("keeps the date and the case rule the file declares", async () => {
    const dated = { ...system, date: "2024-01-01", caseSensitive: false }
    const [read] = await run(parse("a.json", JSON.stringify(dated)))
    expect(read?.date).toBe("2024-01-01")
    expect(read?.caseSensitive).toBe(false)
  })

  it("reads a bundle of code systems as all of them", async () => {
    const bundle = {
      resourceType: "Bundle",
      entry: [
        { resource: system },
        { resource: { ...system, url: "http://example.test/plants", version: "2" } }
      ]
    }
    const read = await run(parse("b.json", JSON.stringify(bundle)))
    expect(read.map((s) => s.url)).toEqual([
      "http://example.test/animals",
      "http://example.test/plants"
    ])
  })
})

describe("refusals", () => {
  it("refuses a file that is not json", async () => {
    expect(await reason(parse("a.json", "{"))).toContain("a.json: not json")
  })

  it("refuses a file that is not a code system", async () => {
    const other = { resourceType: "ValueSet", url: "http://example.test/vs" }
    expect(await reason(parse("a.json", JSON.stringify(other))))
      .toContain("a.json: not a code system")
  })

  it("refuses a file holding something that is not a resource at all", async () => {
    expect(await reason(parse("a.json", "[1,2]"))).toContain("not a code system")
    expect(await reason(parse("a.json", "\"text\""))).toContain("not a code system")
  })

  it("refuses a code system that carries no concept", async () => {
    const empty = { ...system, concept: [] }
    expect(await reason(parse("a.json", JSON.stringify(empty))))
      .toContain("carries no concept")
    const absent = { resourceType: "CodeSystem", url: system.url, content: "not-present" }
    expect(await reason(parse("a.json", JSON.stringify(absent))))
      .toContain("carries no concept")
  })

  it("refuses a code system that declares no content kind", async () => {
    const { content: _content, ...rest } = system
    expect(await reason(parse("a.json", JSON.stringify(rest)))).toContain("content")
  })

  it("refuses a code system with no address", async () => {
    const { url: _url, ...rest } = system
    expect(await reason(parse("a.json", JSON.stringify(rest)))).toContain("url")
  })

  it("refuses a bundle that carries no code system", async () => {
    const bundle = { resourceType: "Bundle", entry: [] }
    expect(await reason(parse("b.json", JSON.stringify(bundle))))
      .toContain("b.json: carries no code system")
    expect(await reason(parse("b.json", JSON.stringify({ resourceType: "Bundle" }))))
      .toContain("carries no code system")
  })

  it("refuses a bundle entry that is not a code system, naming the entry", async () => {
    const bundle = {
      resourceType: "Bundle",
      entry: [{ resource: system }, { resource: { resourceType: "ValueSet" } }]
    }
    expect(await reason(parse("b.json", JSON.stringify(bundle))))
      .toContain("b.json[1]: not a code system")
  })

  it("refuses every failure as a rejection, not an invented error", async () => {
    expect(await reason(parse("a.json", "{"))).toContain("Rejected")
  })
})

describe("loading a named directory", () => {
  it("reads every file the port lists", async () => {
    const entries = {
      "one.json": JSON.stringify(system),
      "two.json": JSON.stringify({ ...system, url: "http://example.test/plants" })
    }
    const loaded = await run(Effect.provide(load("dir"), layerOf(entries)))
    expect(loaded.map((s) => s.url)).toEqual([
      "http://example.test/animals",
      "http://example.test/plants"
    ])
  })

  it("refuses the whole load when one file is refused, naming the file", async () => {
    const entries = {
      "one.json": JSON.stringify(system),
      "two.json": JSON.stringify({ resourceType: "ValueSet" })
    }
    expect(await reason(Effect.provide(load("dir"), layerOf(entries))))
      .toContain("two.json: not a code system")
  })

  it("loads nothing from an empty directory", async () => {
    expect(await run(Effect.provide(load("dir"), layerOf({})))).toEqual([])
  })
})

describe("reading a real directory", () => {
  it("reads the code system files in it and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terminology-"))
    try {
      await writeFile(join(dir, "a.json"), JSON.stringify(system), "utf8")
      await writeFile(join(dir, "notes.txt"), "not a code system", "utf8")
      await mkdir(join(dir, "nested.json"))
      const files = Layer.succeed(TerminologyFiles, nodeFiles)
      const loaded = await run(Effect.provide(load(dir), files))
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.url).toBe("http://example.test/animals")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("reports a directory it cannot read as unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "terminology-"))
    await rm(dir, { recursive: true, force: true })
    expect(await reason(load(dir).pipe(Effect.provide(Layer.succeed(TerminologyFiles, nodeFiles)))))
      .toContain("Unavailable")
    expect(await reason(nodeFiles.read(join(dir, "gone.json")))).toContain("Unavailable")
  })
})
