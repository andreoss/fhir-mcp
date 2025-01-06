import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { TerminologyFiles } from "./load.js"
import type { Files } from "./load.js"
import { TerminologyPort } from "./port.js"
import { fromDirectory, layer, make } from "./terminology.js"
import { reasonFor, unsupplied } from "./system.js"
import type { CodeSystem, Sources } from "./system.js"

const ANIMALS = "http://example.test/animals"
const ABSENT = "http://example.test/absent"

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

const fragment: CodeSystem = {
  url: "http://example.test/partial",
  content: "fragment",
  concept: [{ code: "known", display: "Known" }]
}

const record = unsupplied(ABSENT, "not-present")

const sources: Sources = {
  published: [animals, fragment],
  unsupplied: [record],
  valueSets: [{ url: "http://example.test/vs/all", include: [{ system: ANIMALS }] }]
}

const port = make(sources)

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const failure = async <A>(effect: Effect.Effect<A, Failure>): Promise<Failure> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") return result.cause.error
  throw new Error("expected a failure")
}

describe("lookup", () => {
  it("finds a code and what the system says about it", async () => {
    const found = await run(port.lookup({ system: ANIMALS, code: "cat" }))
    expect(found._tag).toBe("Found")
    expect(found).toMatchObject({
      system: ANIMALS,
      version: "1",
      code: "cat",
      display: "Cat",
      inactive: false
    })
    expect(found._tag === "Found" ? found.designation : []).toHaveLength(1)
  })

  it("reports an inactive code as inactive rather than hiding it", async () => {
    const found = await run(port.lookup({ system: ANIMALS, code: "dog" }))
    expect(found._tag === "Found" ? found.inactive : undefined).toBe(true)
  })

  it("refuses a code a complete system does not carry", async () => {
    const error = await failure(port.lookup({ system: ANIMALS, code: "sasquatch" }))
    expect(error._tag).toBe("NotFound")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("sasquatch")
  })

  it("does not answer for a system the publication names without content", async () => {
    const found = await run(port.lookup({ system: ABSENT, code: "anything" }))
    expect(found._tag).toBe("Unsupplied")
    expect(found).toMatchObject({ system: ABSENT, content: "not-present", reason: record.reason })
  })

  it("does not answer for a system nothing here defines", async () => {
    const found = await run(port.lookup({ system: "http://example.test/nowhere", code: "x" }))
    expect(found).toMatchObject({ content: "referenced", reason: reasonFor("referenced") })
  })

  it("does not answer for a code outside a fragment it holds", async () => {
    expect((await run(port.lookup({ system: fragment.url, code: "known" })))._tag).toBe("Found")
    const outside = await run(port.lookup({ system: fragment.url, code: "other" }))
    expect(outside).toMatchObject({ content: "fragment", reason: reasonFor("fragment") })
  })
})

describe("subsumption", () => {
  it("answers that an ancestor subsumes its descendant", async () => {
    expect(await run(port.subsumes({ system: ANIMALS, left: "animal", right: "cat" })))
      .toBe("subsumes")
  })

  it("answers the other direction as subsumed-by", async () => {
    expect(await run(port.subsumes({ system: ANIMALS, left: "cat", right: "animal" })))
      .toBe("subsumed-by")
  })

  it("answers equivalent for one code against itself", async () => {
    expect(await run(port.subsumes({ system: ANIMALS, left: "cat", right: "cat" })))
      .toBe("equivalent")
  })

  it("answers not-subsumed for two codes on different branches", async () => {
    expect(await run(port.subsumes({ system: ANIMALS, left: "bird", right: "cat" })))
      .toBe("not-subsumed")
  })

  it("refuses a code a complete system does not carry", async () => {
    expect((await failure(port.subsumes({ system: ANIMALS, left: "animal", right: "x" })))._tag)
      .toBe("NotFound")
    expect((await failure(port.subsumes({ system: ANIMALS, left: "x", right: "animal" })))._tag)
      .toBe("NotFound")
  })

  it("answers unknown, not not-subsumed, over a system named without content", async () => {
    const answer = await run(port.subsumes({ system: ABSENT, left: "a", right: "b" }))
    expect(answer).toBe("unknown")
    expect(answer).not.toBe("not-subsumed")
  })

  it("answers unknown over a system nothing here defines", async () => {
    expect(await run(port.subsumes({
      system: "http://example.test/nowhere",
      left: "a",
      right: "b"
    }))).toBe("unknown")
  })

  it("answers unknown for a code outside a fragment it holds", async () => {
    expect(await run(port.subsumes({ system: fragment.url, left: "known", right: "other" })))
      .toBe("unknown")
  })
})

describe("comparison", () => {
  it("compares two codes as codes when the content is held", async () => {
    expect(await run(port.compare({ system: ANIMALS, left: "cat", right: "cat" })))
      .toEqual({ _tag: "Codes", equal: true })
    expect(await run(port.compare({ system: ANIMALS, left: "cat", right: "dog" })))
      .toEqual({ _tag: "Codes", equal: false })
  })

  it("compares as text over a system named without content", async () => {
    const answer = await run(port.compare({ system: ABSENT, left: "1234-5", right: "1234-5" }))
    expect(answer).toEqual({ _tag: "Text", equal: true, reason: record.reason })
  })

  it("compares as text over a system nothing here defines", async () => {
    const answer = await run(port.compare({
      system: "http://example.test/nowhere",
      left: "a",
      right: "b"
    }))
    expect(answer).toEqual({ _tag: "Text", equal: false, reason: reasonFor("referenced") })
  })

  it("compares as text for a code outside a fragment it holds", async () => {
    const answer = await run(port.compare({ system: fragment.url, left: "other", right: "other" }))
    expect(answer).toMatchObject({ _tag: "Text", equal: true })
  })

  it("refuses a code a complete system does not carry", async () => {
    expect((await failure(port.compare({ system: ANIMALS, left: "cat", right: "x" })))._tag)
      .toBe("NotFound")
  })

  it("ignores case where the system says case does not count", async () => {
    const loose: CodeSystem = {
      url: "http://example.test/loose",
      content: "complete",
      caseSensitive: false,
      concept: [{ code: "Cat" }]
    }
    const other = make({ published: [loose] })
    expect(await run(other.compare({ system: loose.url, left: "CAT", right: "cat" })))
      .toEqual({ _tag: "Codes", equal: true })
  })
})

describe("precedence between sources", () => {
  it("answers from a stored system before a published one", async () => {
    const stored: CodeSystem = {
      url: ANIMALS,
      version: "1",
      content: "complete",
      concept: [{ code: "cat", display: "Stored cat" }]
    }
    const other = make({ published: [animals], stored: [stored] })
    const found = await run(other.lookup({ system: ANIMALS, code: "cat" }))
    expect(found._tag === "Found" ? found.display : "").toBe("Stored cat")
  })
})

describe("the port", () => {
  it("expands a value set through the port, stamping the answer", async () => {
    const expansion = await run(port.expand({ url: "http://example.test/vs/all", count: 2 }))
    expect(expansion.expansion.total).toBe(5)
    expect(expansion.expansion.contains).toHaveLength(2)
    expect(Number.isNaN(Date.parse(expansion.expansion.timestamp))).toBe(false)
  })

  it("renders every failure it can produce as an operation outcome", async () => {
    const error = await failure(port.expand({ url: "http://example.test/vs/none" }))
    const outcome = toOutcome(error)
    expect(outcome.resourceType).toBe("OperationOutcome")
    expect(outcome.issue[0]?.severity).toBe("error")
  })

  it("is supplied as a layer", async () => {
    const answer = await run(
      Effect.flatMap(TerminologyPort, (terminology) =>
        terminology.subsumes({ system: ANIMALS, left: "animal", right: "cat" })
      ).pipe(Effect.provide(layer(sources)))
    )
    expect(answer).toBe("subsumes")
  })
})

describe("loading a directory into the sources", () => {
  const file = JSON.stringify({
    resourceType: "CodeSystem",
    url: ANIMALS,
    content: "complete",
    concept: [{ code: "cat", display: "Loaded cat" }]
  })

  const files: Files = {
    list: () => Effect.succeed(["a.json"]),
    read: () => Effect.succeed(file)
  }

  it("lets a loaded system replace every version of the published one", async () => {
    const loaded = await run(
      fromDirectory("dir", sources).pipe(Effect.provide(Layer.succeed(TerminologyFiles, files)))
    )
    const other = make(loaded)
    const found = await run(other.lookup({ system: ANIMALS, code: "cat", version: "1" }))
    expect(found._tag === "Found" ? found.display : "").toBe("Loaded cat")
  })
})
