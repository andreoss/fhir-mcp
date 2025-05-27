import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { toOutcome } from "../core/outcome.js"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { ResponseEntity } from "./remote.js"
import { remoteTerminology, hybrid } from "./remote.js"
import type { Fetcher, RemoteSource } from "./remote.js"
import type { Terminology } from "./port.js"
import { reasonFor } from "./system.js"

const SOURCE: RemoteSource = {
  name: "upstream",
  baseUrl: "https://term.example",
  bearer: "a-secret",
  timeoutMs: 500,
  retryAfterMs: 1000,
  maxBytes: 4096
}

const reply = (status: number, body: string): ResponseEntity => ({ status, headers: {}, body })

const harness = (plan: (url: string) => ResponseEntity) => {
  const seen: Array<string> = []
  const port = remoteTerminology(SOURCE, {
    get: (url, _headers) => {
      seen.push(url)
      return Effect.succeed(plan(url))
    }
  })
  const failing: Fetcher = {
    get: () => Effect.fail(new Unavailable({ dependency: "upstream" }))
  }
  return { port, failing, seen }
}

const found = async (port: Terminology) => {
  const exit = await Effect.runPromiseExit(port.lookup({ system: "http://loinc.org", code: "cat" }))
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected a lookup")
}

const failure = async (effect: Effect.Effect<unknown, Failure>): Promise<Failure> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a failure")
}

describe("remote terminology adapter", () => {
  it("resolves a code the local source does not carry, with display", async () => {
    const held = harness((url) => {
      expect(url).toContain("/lookup?system=http%3A%2F%2Floinc.org&code=cat")
      return reply(200, JSON.stringify({
        status: "found",
        version: "2.77",
        code: "cat",
        display: "Feline",
        inactive: false,
        designation: []
      }))
    })
    const answer = await found(held.port)
    expect(answer).toMatchObject({
      _tag: "Found",
      system: "http://loinc.org",
      version: "2.77",
      code: "cat",
      display: "Feline",
      inactive: false
    })
  })

  it("carries the configured credential on the request", async () => {
    const seen: Array<Record<string, string>> = []
    const port = remoteTerminology(SOURCE, {
      get: (_url, headers) => {
        seen.push(headers)
        return Effect.succeed(reply(200, JSON.stringify({ status: "empty" })))
      }
    })
    await Effect.runPromise(port.lookup({ system: "http://loinc.org", code: "cat" }))
    expect(seen[0]?.["authorization"]).toBe("Bearer a-secret")
  })

  it("names an authentication refusal as a refused request", async () => {
    const held = harness(() => reply(401, "{}"))
    const error = await failure(held.port.lookup({ system: "http://loinc.org", code: "cat" }))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("authentication")
  })

  it("answers an empty source as unsupplied, distinguished from a refusal", async () => {
    const held = harness((url) =>
      url.includes("code=other")
        ? reply(401, "{}")
        : reply(200, JSON.stringify({ status: "empty", content: "not-present", reason: "no such code" }))
    )
    const answer = await found(held.port)
    expect(answer._tag).toBe("Unsupplied")
    if (answer._tag !== "Unsupplied") return
    expect(answer.content).toBe("not-present")
    expect(answer.reason).toContain("no such code")
    const refused = await failure(held.port.lookup({ system: "http://loinc.org", code: "other" }))
    expect(refused._tag).toBe("Rejected")
  })

  it("turns a transport fault into an unavailable outcome", async () => {
    const port = remoteTerminology(SOURCE, {
      get: () => Effect.fail(new Unavailable({ dependency: "upstream (retry after 1000ms)" }))
    })
    const error = await failure(port.lookup({ system: "http://loinc.org", code: "cat" }))
    expect(error._tag).toBe("Unavailable")
    expect(toOutcome(error).issue[0]?.code).toBe("transient")
  })

  it("refuses an answer that is not in the accepted shape", async () => {
    const held = harness(() => reply(200, "<html>"))
    const error = await failure(held.port.lookup({ system: "http://loinc.org", code: "cat" }))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("shape")
  })

  it("answers subsumption from the remote", async () => {
    const held = harness((url) => {
      expect(url).toContain("left=a&right=cat")
      return reply(200, JSON.stringify({ answer: "subsumes" }))
    })
    const answer = await Effect.runPromise(
      held.port.subsumes({ system: "http://loinc.org", left: "a", right: "cat" })
    )
    expect(answer).toBe("subsumes")
  })

  it("answers a comparison from the remote", async () => {
    const held = harness(() => reply(200, JSON.stringify({ match: "codes", equal: true })))
    const answer = await Effect.runPromise(
      held.port.compare({ system: "http://loinc.org", left: "cat", right: "cat" })
    )
    expect(answer).toEqual({ _tag: "Codes", equal: true })
  })

  it("passes an expansion through with the ranking named and scored codes", async () => {
    const held = harness(() =>
      reply(200, JSON.stringify({
        resourceType: "ValueSet",
        url: "http://loinc.org/vs/all",
        expansion: {
          timestamp: "2026-01-01T00:00:00.000Z",
          total: 2,
          ranking: "commonness",
          contains: [
            { system: "http://loinc.org", code: "a", display: "Alpha", rank: 1, score: 0.9 },
            { system: "http://loinc.org", code: "b", display: "Beta", rank: 2, score: 0.4 }
          ]
        }
      }))
    )
    const expansion = await Effect.runPromise(
      held.port.expand({ url: "http://loinc.org/vs/all" })
    )
    expect(expansion.expansion.total).toBe(2)
    expect(expansion.expansion.parameter).toContainEqual({ name: "ranking", value: "commonness" })
    expect(expansion.expansion.contains[0]?.rank).toBe(1)
    expect(expansion.expansion.contains[1]?.score).toBe(0.4)
  })

  it("names an unranked remote expansion as unranked", async () => {
    const held = harness(() =>
      reply(200, JSON.stringify({
        resourceType: "ValueSet",
        url: "http://loinc.org/vs/all",
        expansion: {
          timestamp: "2026-01-01T00:00:00.000Z",
          total: 0,
          contains: []
        }
      }))
    )
    const expansion = await Effect.runPromise(
      held.port.expand({ url: "http://loinc.org/vs/all" })
    )
    expect(expansion.expansion.parameter).toContainEqual({ name: "ranking", value: "none" })
  })

  it("refuses an expansion the remote refuses", async () => {
    const held = harness(() => reply(403, "{}"))
    const error = await failure(held.port.expand({ url: "http://loinc.org/vs/all" }))
    expect(error._tag).toBe("Rejected")
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("authentication")
  })
})

describe("composition with the local sources", () => {
  const remoteFound: Terminology = {
    lookup: (request) =>
      Effect.succeed({
        _tag: "Found",
        system: request.system,
        version: undefined,
        code: request.code,
        display: "Remote display",
        inactive: false,
        designation: []
      }),
    subsumes: (_request) => Effect.succeed("subsumes"),
    compare: (request) => Effect.succeed({ _tag: "Codes", equal: request.left === request.right }),
    expand: (request) =>
      Effect.succeed({
        resourceType: "ValueSet",
        url: request.url,
        version: undefined,
        expansion: {
          timestamp: "2026-01-01T00:00:00.000Z",
          total: 0,
          offset: undefined,
          parameter: [{ name: "ranking", value: "none" }],
          contains: []
        }
      })
  }

  const local = {
    lookup: () =>
      Effect.succeed({
        _tag: "Unsupplied" as const,
        system: "http://loinc.org",
        content: "referenced" as const,
        reason: reasonFor("referenced")
      }),
    subsumes: () => Effect.succeed("unknown" as const),
    compare: () =>
      Effect.succeed({ _tag: "Text" as const, equal: false, reason: reasonFor("referenced") }),
    expand: () => Effect.fail(new Rejected({ reason: "unknown code system: x" }))
  }

  const composed = hybrid(local, remoteFound)

  it("asks the remote for a system the local source does not carry", async () => {
    const answer = await found(composed)
    expect(answer._tag === "Found" ? answer.display : "").toBe("Remote display")
  })

  it("asks the remote where the local answer is unknown", async () => {
    expect(await Effect.runPromise(composed.subsumes({ system: "x", left: "a", right: "b" })))
      .toBe("subsumes")
    expect(
      await Effect.runPromise(composed.compare({ system: "x", left: "a", right: "a" }))
    ).toEqual({ _tag: "Codes", equal: true })
  })

  it("asks the remote where the local source cannot expand the system", async () => {
    const expansion = await Effect.runPromise(composed.expand({ url: "http://loinc.org/vs/all" }))
    expect(expansion.expansion.total).toBe(0)
  })

  it("keeps a local answer that is definitive", async () => {
    const definite = {
      ...local,
      lookup: () =>
        Effect.succeed({
          _tag: "Unsupplied" as const,
          system: "http://loinc.org",
          content: "not-present" as const,
          reason: "declares itself"
        })
    }
    const kept = hybrid(definite, remoteFound)
    const answer = await found(kept)
    expect(answer._tag === "Unsupplied" ? answer.content : "").toBe("not-present")
    expect(await Effect.runPromise(kept.lookup({ system: "http://loinc.org", code: "x" }) as any))
      .toMatchObject({ content: "not-present" })
  })

  it("keeps a local expansion rejection that is about this request, not the source", async () => {
    const strict = {
      ...local,
      expand: () => Effect.fail(new Rejected({ reason: "versions expects system|version, got x" }))
    }
    const error = await failure(hybrid(strict, remoteFound).expand({ url: "http://loinc.org/vs/all" }))
    expect(toOutcome(error).issue[0]?.diagnostics).toContain("system|version")
  })

  it("does not fabricate a descendant relationship the local content denies", async () => {
    const denying = {
      ...local,
      subsumes: () => Effect.succeed("not-subsumed" as const)
    }
    const kept = hybrid(denying, remoteFound)
    expect(await Effect.runPromise(kept.subsumes({ system: "x", left: "a", right: "b" })))
      .toBe("not-subsumed")
  })
})