import { describe, expect, it } from "vitest"
import { ancestorOf, asOf, byCode, findConcept, reasonFor, resolve, unsupplied } from "./system.js"
import type { CodeSystem, Sources } from "./system.js"

const animals = (version: string, tag: string): CodeSystem => ({
  url: "http://example.test/animals",
  version,
  content: "complete",
  concept: [
    { code: "animal", display: `Animal ${tag}` },
    { code: "mammal", display: "Mammal", parent: "animal" },
    { code: "cat", display: "Cat", parent: "mammal" }
  ]
})

const versionless = (tag: string): CodeSystem => ({
  url: "http://example.test/animals",
  content: "complete",
  concept: [{ code: "animal", display: `Animal ${tag}` }]
})

const displayOf = (sources: Sources, version?: string): string | undefined => {
  const found = resolve(sources, "http://example.test/animals", version)
  return found._tag === "System" ? found.system.concept[0]?.display : undefined
}

describe("code system", () => {
  it("indexes every concept by its code", () => {
    const index = byCode(animals("1", "x"))
    expect([...index.keys()]).toEqual(["animal", "mammal", "cat"])
    expect(index.get("cat")?.parent).toBe("mammal")
  })

  it("walks the hierarchy more than one level up", () => {
    expect(ancestorOf(animals("1", "x"), "animal", "cat")).toBe(true)
    expect(ancestorOf(animals("1", "x"), "mammal", "cat")).toBe(true)
  })

  it("is not its own ancestor and not its sibling's", () => {
    expect(ancestorOf(animals("1", "x"), "cat", "cat")).toBe(false)
    expect(ancestorOf(animals("1", "x"), "cat", "mammal")).toBe(false)
    expect(ancestorOf(animals("1", "x"), "cat", "absent")).toBe(false)
  })

  it("terminates on a hierarchy that loops back on itself", () => {
    const looped: CodeSystem = {
      url: "http://example.test/loop",
      content: "complete",
      concept: [
        { code: "a", parent: "b" },
        { code: "b", parent: "a" }
      ]
    }
    expect(ancestorOf(looped, "a", "b")).toBe(true)
    expect(ancestorOf(looped, "c", "b")).toBe(false)
  })

  it("finds a code exactly, and loosely only where case does not count", () => {
    const loose: CodeSystem = {
      url: "http://example.test/loose",
      content: "complete",
      caseSensitive: false,
      concept: [{ code: "Cat" }]
    }
    expect(findConcept(loose, "Cat")?.code).toBe("Cat")
    expect(findConcept(loose, "CAT")?.code).toBe("Cat")
    expect(findConcept(animals("1", "x"), "CAT")).toBeUndefined()
    expect(findConcept(loose, "dog")).toBeUndefined()
  })
})

describe("what is not held", () => {
  it("gives a reason for every kind of absence", () => {
    const kinds = [
      "complete",
      "fragment",
      "example",
      "supplement",
      "not-present",
      "referenced"
    ] as const
    for (const kind of kinds) expect(reasonFor(kind).length).toBeGreaterThan(0)
  })

  it("records an unsupplied system with its declared kind and the reason", () => {
    const record = unsupplied("http://example.test/absent", "fragment", "4")
    expect(record.content).toBe("fragment")
    expect(record.version).toBe("4")
    expect(record.reason).toBe(reasonFor("fragment"))
    expect(unsupplied("http://example.test/absent", "referenced").version).toBeUndefined()
  })
})

describe("resolution", () => {
  const published = [animals("1", "published"), animals("2", "published")]

  it("answers from the publication when nothing replaces it", () => {
    expect(displayOf({ published }, "1")).toBe("Animal published")
  })

  it("reports a system named without content as unsupplied", () => {
    const record = unsupplied("http://example.test/absent", "not-present")
    const found = resolve({ unsupplied: [record] }, "http://example.test/absent")
    expect(found._tag).toBe("Unsupplied")
    expect(found._tag === "Unsupplied" ? found.record.reason : "").toBe(record.reason)
  })

  it("matches an unsupplied record recorded against one version only", () => {
    const record = unsupplied("http://example.test/absent", "fragment", "4")
    expect(resolve({ unsupplied: [record] }, "http://example.test/absent", "4")._tag)
      .toBe("Unsupplied")
    expect(resolve({ unsupplied: [record] }, "http://example.test/absent", "5")._tag)
      .toBe("Unknown")
  })

  it("knows nothing of an address no source names", () => {
    const found = resolve({ published }, "http://example.test/nowhere")
    expect(found._tag).toBe("Unknown")
    expect(found._tag === "Unknown" ? found.url : "").toBe("http://example.test/nowhere")
  })

  it("replaces only the published system of the version a loaded one carries", () => {
    const sources: Sources = { published, loaded: [animals("1", "loaded")] }
    expect(displayOf(sources, "1")).toBe("Animal loaded")
    expect(displayOf(sources, "2")).toBe("Animal published")
  })

  it("replaces every version of an address when the loaded system carries none", () => {
    const sources: Sources = { published, loaded: [versionless("loaded")] }
    expect(displayOf(sources, "1")).toBe("Animal loaded")
    expect(displayOf(sources, "2")).toBe("Animal loaded")
    expect(displayOf(sources)).toBe("Animal loaded")
  })

  it("answers with the latest published version when none is asked for", () => {
    expect(displayOf({ published })).toBe("Animal published")
    expect(resolve({ published }, "http://example.test/animals")).toMatchObject({
      system: { version: "2" }
    })
  })

  it("answers from a stored system before a published one at the same address", () => {
    expect(displayOf({ published, stored: [animals("1", "stored")] }, "1")).toBe("Animal stored")
  })

  it("answers from a stored system before a loaded one at the same address", () => {
    const sources: Sources = {
      published,
      loaded: [animals("1", "loaded")],
      stored: [animals("1", "stored")]
    }
    expect(displayOf(sources, "1")).toBe("Animal stored")
  })
})

describe("as of a date", () => {
  const dated = (version: string, date: string): CodeSystem => ({
    ...animals(version, version),
    date
  })

  it("keeps only what was published at or before the date", () => {
    const sources: Sources = { published: [dated("1", "2020-01-01"), dated("2", "2024-01-01")] }
    expect(resolve(asOf(sources, "2021-01-01"), "http://example.test/animals"))
      .toMatchObject({ system: { version: "1" } })
    expect(resolve(asOf(sources, "2019-01-01"), "http://example.test/animals")._tag)
      .toBe("Unknown")
  })

  it("keeps an undated system and carries the other sources through", () => {
    const record = unsupplied("http://example.test/absent", "example")
    const sources: Sources = {
      published: [animals("1", "x")],
      unsupplied: [record],
      valueSets: [{ url: "http://example.test/vs", include: [] }]
    }
    const narrowed = asOf(sources, "2019-01-01")
    expect(resolve(narrowed, "http://example.test/animals")._tag).toBe("System")
    expect(narrowed.unsupplied).toEqual([record])
    expect(narrowed.valueSets).toHaveLength(1)
  })
})
