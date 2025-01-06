import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { expand } from "./expand.js"
import { unsupplied } from "./system.js"
import type { CodeSystem, Sources, ValueSet } from "./system.js"
import type { Contains, ExpandRequest } from "./port.js"

const STAMP = "2026-01-01T00:00:00.000Z"
const ANIMALS = "http://example.test/animals"
const ALL = "http://example.test/vs/all"

const animals: CodeSystem = {
  url: ANIMALS,
  version: "1",
  content: "complete",
  concept: [
    { code: "animal", display: "Animal" },
    { code: "mammal", display: "Mammal", parent: "animal" },
    {
      code: "cat",
      display: "Cat",
      parent: "mammal",
      designation: [{ language: "de", value: "Katze" }]
    },
    { code: "dog", display: "Canine", parent: "mammal", inactive: true },
    { code: "bird", display: "Bird", parent: "animal" }
  ]
}

const all: ValueSet = { url: ALL, version: "7", include: [{ system: ANIMALS }] }

const sources: Sources = { published: [animals], valueSets: [all] }

const run = (request: ExpandRequest, from: Sources = sources) =>
  Effect.runPromise(expand(from, request, STAMP))

const failure = async (request: ExpandRequest, from: Sources = sources): Promise<Failure> => {
  const result = await Effect.runPromiseExit(expand(from, request, STAMP))
  if (Exit.isFailure(result) && result.cause._tag === "Fail") return result.cause.error
  throw new Error("expected a failure")
}

const codes = (contains: ReadonlyArray<Contains>): ReadonlyArray<string> =>
  contains.flatMap((entry) => [entry.code, ...codes(entry.contains ?? [])])

describe("value set expansion", () => {
  it("expands every concept the value set names", async () => {
    const expansion = await run({ url: ALL, excludeNested: true })
    expect(expansion.resourceType).toBe("ValueSet")
    expect(expansion.url).toBe(ALL)
    expect(expansion.version).toBe("7")
    expect(expansion.expansion.timestamp).toBe(STAMP)
    expect(expansion.expansion.total).toBe(5)
    expect(codes(expansion.expansion.contains))
      .toEqual(["animal", "mammal", "cat", "dog", "bird"])
    expect(expansion.expansion.contains[0]?.system).toBe(ANIMALS)
    expect(expansion.expansion.contains[0]?.version).toBe("1")
  })

  it("refuses a value set it does not hold", async () => {
    const error = await failure({ url: "http://example.test/vs/none" })
    expect(error._tag).toBe("NotFound")
    expect(toOutcome(error).issue[0]?.code).toBe("not-found")
  })

  it("nests by the hierarchy unless nesting is excluded", async () => {
    const expansion = await run({ url: ALL })
    const top = expansion.expansion.contains
    expect(top.map((entry) => entry.code)).toEqual(["animal"])
    expect((top[0]?.contains ?? []).map((entry) => entry.code)).toEqual(["mammal", "bird"])
    expect((top[0]?.contains?.[0]?.contains ?? []).map((entry) => entry.code))
      .toEqual(["cat", "dog"])
    expect(top[0]?.contains?.[1]?.contains).toBeUndefined()
  })

  it("returns a flat list when nesting is excluded", async () => {
    const expansion = await run({ url: ALL, excludeNested: true })
    expect(expansion.expansion.contains).toHaveLength(5)
    expect(expansion.expansion.contains.every((entry) => entry.contains === undefined)).toBe(true)
  })
})

describe("expansion filter", () => {
  it("matches on the code", async () => {
    const expansion = await run({ url: ALL, filter: "cat", excludeNested: true })
    expect(codes(expansion.expansion.contains)).toEqual(["cat"])
  })

  it("matches on the display text as well as the code", async () => {
    const expansion = await run({ url: ALL, filter: "canine", excludeNested: true })
    expect(codes(expansion.expansion.contains)).toEqual(["dog"])
  })

  it("matches without regard to case", async () => {
    const expansion = await run({ url: ALL, filter: "CANINE", excludeNested: true })
    expect(codes(expansion.expansion.contains)).toEqual(["dog"])
  })

  it("matches the display the requested language gives", async () => {
    const expansion = await run({
      url: ALL,
      filter: "katz",
      displayLanguage: "de",
      excludeNested: true
    })
    expect(codes(expansion.expansion.contains)).toEqual(["cat"])
    expect(expansion.expansion.contains[0]?.display).toBe("Katze")
  })

  it("matches nothing it does not carry", async () => {
    const expansion = await run({ url: ALL, filter: "sasquatch", excludeNested: true })
    expect(expansion.expansion.total).toBe(0)
    expect(expansion.expansion.contains).toEqual([])
  })
})

describe("expansion of active concepts only", () => {
  it("excludes an inactive concept when only active ones are asked for", async () => {
    const expansion = await run({ url: ALL, activeOnly: true, excludeNested: true })
    expect(codes(expansion.expansion.contains)).not.toContain("dog")
    expect(expansion.expansion.total).toBe(4)
  })

  it("marks an inactive concept when it is kept", async () => {
    const expansion = await run({ url: ALL, excludeNested: true })
    expect(expansion.expansion.contains[3]?.inactive).toBe(true)
    expect(expansion.expansion.contains[2]?.inactive).toBeUndefined()
  })
})

describe("expansion paging", () => {
  it("returns the page asked for", async () => {
    const expansion = await run({ url: ALL, offset: 1, count: 2 })
    expect(codes(expansion.expansion.contains)).toEqual(["mammal", "cat"])
    expect(expansion.expansion.total).toBe(5)
    expect(expansion.expansion.offset).toBe(1)
  })

  it("returns the short last page at the boundary", async () => {
    const expansion = await run({ url: ALL, offset: 3, count: 3 })
    expect(codes(expansion.expansion.contains)).toEqual(["dog", "bird"])
    expect(expansion.expansion.total).toBe(5)
  })

  it("returns nothing past the end without losing the total", async () => {
    const expansion = await run({ url: ALL, offset: 5, count: 3 })
    expect(expansion.expansion.contains).toEqual([])
    expect(expansion.expansion.total).toBe(5)
  })

  it("returns the total alone when no concept is asked for", async () => {
    const expansion = await run({ url: ALL, count: 0 })
    expect(expansion.expansion.contains).toEqual([])
    expect(expansion.expansion.total).toBe(5)
  })

  it("flattens a paged expansion, and says so", async () => {
    const expansion = await run({ url: ALL, count: 3 })
    expect(expansion.expansion.contains).toHaveLength(3)
    expect(expansion.expansion.contains.every((entry) => entry.contains === undefined)).toBe(true)
    expect(expansion.expansion.parameter).toContainEqual({ name: "excludeNested", value: true })
  })

  it("refuses a page that cannot be taken", async () => {
    expect((await failure({ url: ALL, count: -1 }))._tag).toBe("Rejected")
    expect((await failure({ url: ALL, offset: -1 }))._tag).toBe("Rejected")
    expect((await failure({ url: ALL, count: 1.5 }))._tag).toBe("Rejected")
  })
})

describe("expansion designations", () => {
  it("leaves designations out unless they are asked for", async () => {
    const expansion = await run({ url: ALL, excludeNested: true })
    expect(expansion.expansion.contains[2]?.designation).toBeUndefined()
  })

  it("carries designations when they are asked for", async () => {
    const expansion = await run({ url: ALL, designations: true, excludeNested: true })
    expect(expansion.expansion.contains[2]?.designation).toEqual([
      { language: "de", value: "Katze" }
    ])
    expect(expansion.expansion.contains[0]?.designation).toEqual([])
  })

  it("echoes every parameter it was given", async () => {
    const expansion = await run({
      url: ALL,
      filter: "a",
      count: 2,
      offset: 0,
      date: "2026-01-01",
      activeOnly: false,
      displayLanguage: "de",
      designations: true,
      excludeNested: true,
      versions: [`${ANIMALS}|1`]
    })
    const named = expansion.expansion.parameter.map((parameter) => parameter.name)
    expect(named).toEqual(
      expect.arrayContaining([
        "filter",
        "count",
        "offset",
        "date",
        "activeOnly",
        "displayLanguage",
        "includeDesignations",
        "excludeNested",
        "system-version"
      ])
    )
  })
})

describe("expansion by composition", () => {
  const composed = (include: ValueSet["include"], exclude?: ValueSet["exclude"]): Sources => ({
    published: [animals],
    valueSets: [
      exclude === undefined
        ? { url: ALL, include }
        : { url: ALL, include, exclude }
    ]
  })

  it("takes the concepts a value set names one by one", async () => {
    const from = composed([{ system: ANIMALS, concept: [{ code: "cat" }, { code: "bird" }] }])
    const expansion = await run({ url: ALL, excludeNested: true }, from)
    expect(codes(expansion.expansion.contains)).toEqual(["cat", "bird"])
  })

  it("refuses a named code the system does not carry", async () => {
    const from = composed([{ system: ANIMALS, concept: [{ code: "sasquatch" }] }])
    const error = await failure({ url: ALL }, from)
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("sasquatch")
  })

  it("takes a subtree with its root", async () => {
    const from = composed([
      { system: ANIMALS, filter: [{ property: "concept", op: "is-a", value: "mammal" }] }
    ])
    const expansion = await run({ url: ALL, excludeNested: true }, from)
    expect(codes(expansion.expansion.contains)).toEqual(["mammal", "cat", "dog"])
  })

  it("takes a subtree without its root", async () => {
    const from = composed([
      { system: ANIMALS, filter: [{ property: "concept", op: "descendent-of", value: "mammal" }] }
    ])
    const expansion = await run({ url: ALL, excludeNested: true }, from)
    expect(codes(expansion.expansion.contains)).toEqual(["cat", "dog"])
  })

  it("refuses a filter it cannot apply", async () => {
    const from = composed([
      { system: ANIMALS, filter: [{ property: "concept", op: "regex", value: ".*" }] }
    ])
    const error = await failure({ url: ALL }, from)
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("regex")
  })

  it("removes what the value set excludes", async () => {
    const from = composed([{ system: ANIMALS }], [{ system: ANIMALS, concept: [{ code: "dog" }] }])
    const expansion = await run({ url: ALL, excludeNested: true }, from)
    expect(codes(expansion.expansion.contains)).not.toContain("dog")
    expect(expansion.expansion.total).toBe(4)
  })
})

describe("expansion honesty", () => {
  it("refuses to expand a system the publication names without content", async () => {
    const record = unsupplied("http://example.test/absent", "not-present")
    const from: Sources = {
      unsupplied: [record],
      valueSets: [{ url: ALL, include: [{ system: "http://example.test/absent" }] }]
    }
    const error = await failure({ url: ALL }, from)
    expect(error._tag).toBe("Rejected")
    const diagnostics = toOutcome(error).issue[0]?.diagnostics ?? ""
    expect(diagnostics).toContain("http://example.test/absent")
    expect(diagnostics).toContain(record.reason)
  })

  it("refuses to expand a system nothing here defines", async () => {
    const from: Sources = {
      valueSets: [{ url: ALL, include: [{ system: "http://example.test/nowhere" }] }]
    }
    const error = await failure({ url: ALL }, from)
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("unknown code system")
  })
})

describe("expansion at a version and a date", () => {
  const older: CodeSystem = { ...animals, version: "1", date: "2020-01-01" }
  const newer: CodeSystem = { ...animals, version: "2", date: "2024-01-01" }
  const from: Sources = {
    published: [older, newer],
    valueSets: [{ url: ALL, include: [{ system: ANIMALS }] }]
  }

  it("uses the latest version when no date is given", async () => {
    const expansion = await run({ url: ALL, excludeNested: true }, from)
    expect(expansion.expansion.contains[0]?.version).toBe("2")
  })

  it("uses the version in force at the date given", async () => {
    const expansion = await run({ url: ALL, date: "2021-01-01", excludeNested: true }, from)
    expect(expansion.expansion.contains[0]?.version).toBe("1")
  })

  it("refuses a date at which it holds no content for the system", async () => {
    const error = await failure({ url: ALL, date: "2019-01-01" }, from)
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("2019-01-01")
  })

  it("uses the version pinned for the system over the latest", async () => {
    const expansion = await run(
      { url: ALL, versions: [`${ANIMALS}|1`], excludeNested: true },
      from
    )
    expect(expansion.expansion.contains[0]?.version).toBe("1")
  })

  it("ignores a pin naming another system", async () => {
    const expansion = await run(
      { url: ALL, versions: ["http://example.test/other|1"], excludeNested: true },
      from
    )
    expect(expansion.expansion.contains[0]?.version).toBe("2")
  })

  it("refuses a pin that does not name a version", async () => {
    const error = await failure({ url: ALL, versions: [ANIMALS] }, from)
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("system|version")
  })

  it("uses the version named by the include when nothing overrides it", async () => {
    const pinned: Sources = {
      published: [older, newer],
      valueSets: [{ url: ALL, include: [{ system: ANIMALS, version: "1" }] }]
    }
    const expansion = await run({ url: ALL, excludeNested: true }, pinned)
    expect(expansion.expansion.contains[0]?.version).toBe("1")
  })
})
