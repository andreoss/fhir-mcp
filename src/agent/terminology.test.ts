import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Rejected } from "../core/outcome.js"
import { TerminologyPort } from "../terminology/port.js"
import type { Lookup, Terminology } from "../terminology/port.js"
import { layer } from "../terminology/terminology.js"
import type { Sources } from "../terminology/system.js"
import { callTerminology, terminologyTools } from "./terminology.js"

const LOINC = "http://loinc.org"

const sources: Sources = {
  stored: [
    {
      url: LOINC,
      version: "2.74",
      content: "complete",
      concept: [
        { code: "1234-5", display: "Glucose [Mass/volume] in Serum", inactive: false },
        { code: "9-9", display: "Retired code", inactive: true }
      ]
    }
  ],
  unsupplied: [{ url: "http://snomed.info/sct", content: "fragment", reason: "carries a fragment" }]
}

const port = layer(sources)

const served = Layer.succeed(TerminologyPort, {
  lookup: (request) => Effect.fail(new Rejected({ reason: `unserved: ${request.code}` })),
  subsumes: () => Effect.succeed("unknown" as const),
  compare: () => Effect.succeed({ _tag: "Text", equal: false, reason: "unserved" }),
  expand: () => Effect.fail(new Rejected({ reason: "unserved" }))
} satisfies Terminology)

const run = (name: string, args: unknown, given: Layer.Layer<TerminologyPort> = port) =>
  Effect.runSync(callTerminology(name, args).pipe(Effect.provide(given)))

const body = (result: { content: ReadonlyArray<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>

const issueOf = (result: { content: ReadonlyArray<{ text: string }> }) =>
  (body(result)["issue"] as ReadonlyArray<{ code: string; diagnostics: string }>)[0]

const resolved = (result: { content: ReadonlyArray<{ text: string }> }) => {
  const found = body(result) as Lookup
  expect(found._tag).toBe("Found")
  if (found._tag !== "Found") throw new Error("the code did not resolve")
  return found
}

const unsupplied = (result: { content: ReadonlyArray<{ text: string }> }) => {
  const found = body(result) as Lookup
  expect(found._tag).toBe("Unsupplied")
  if (found._tag !== "Unsupplied") throw new Error("the source carried content")
  return found
}

describe("AGT-16 terminology lookup on the tool surface", () => {
  it("declares the lookup tool with a schema and read-only annotations", () => {
    expect(terminologyTools.map((tool) => tool.name)).toEqual(["lookup"])
    const tool = terminologyTools[0]
    expect(tool?.inputSchema.type).toBe("object")
    expect(tool?.inputSchema.required).toEqual(["system", "code"])
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
    expect(tool?.description.length).toBeGreaterThan(0)
  })

  it("resolves a code to its display through the terminology port", () => {
    const result = run("lookup", { system: LOINC, code: "1234-5" })
    expect(result.isError).toBe(false)
    const found = resolved(result)
    expect(found.code).toBe("1234-5")
    expect(found.display).toBe("Glucose [Mass/volume] in Serum")
    expect(found.version).toBe("2.74")
  })

  it("carries the inactive flag and the designations the source holds", () => {
    const found = resolved(run("lookup", { system: LOINC, code: "9-9" }))
    expect(found.inactive).toBe(true)
    expect(found.designation).toEqual([])
  })

  it("answers unsupplied, not as an error, when the source carries no content", () => {
    const result = run("lookup", { system: "http://snomed.info/sct", code: "123" })
    expect(result.isError).toBe(false)
    expect(unsupplied(result).content).toBe("fragment")
  })

  it("passes the version it was given through to the port", () => {
    let asked: string | undefined
    const watched = Layer.succeed(TerminologyPort, {
      lookup: (request) => {
        asked = request.version
        return Effect.succeed<Lookup>({
          _tag: "Found",
          system: request.system,
          version: request.version,
          code: request.code,
          display: "Watched",
          inactive: false,
          designation: []
        })
      },
      subsumes: () => Effect.succeed("unknown" as const),
      compare: () => Effect.succeed({ _tag: "Text", equal: false, reason: "unserved" }),
      expand: () => Effect.fail(new Rejected({ reason: "unserved" }))
    } satisfies Terminology)
    run("lookup", { system: LOINC, code: "1", version: "2.74" }, watched)
    expect(asked).toBe("2.74")
  })

  it("answers an unknown code on a complete source as not-found", () => {
    const result = run("lookup", { system: LOINC, code: "nope" })
    expect(result.isError).toBe(true)
    expect(issueOf(result)?.code).toBe("not-found")
  })

  it("answers a failure of the terminology source as an outcome, not a throw", () => {
    const result = run("lookup", { system: LOINC, code: "1" }, served)
    expect(result.isError).toBe(true)
    expect(body(result)["resourceType"]).toBe("OperationOutcome")
  })

  it("refuses a call that names no code, naming the field", () => {
    const result = run("lookup", { system: LOINC })
    expect(result.isError).toBe(true)
    expect(issueOf(result)?.code).toBe("invalid")
    expect(issueOf(result)?.diagnostics).toContain("code")
  })

  it("refuses an unknown tool name on the terminology surface", () => {
    const result = run("expand", { url: "http://example.org/vs" })
    expect(result.isError).toBe(true)
    expect(issueOf(result)?.diagnostics).toContain("expand")
  })
})
