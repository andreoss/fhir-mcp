import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { MOST, PAGE, at, cut, pageOf, sized } from "./page.js"
import type { Params } from "./page.js"
import { issue } from "../agent/cursor.js"
import type { Version } from "../core/interactions.js"

const params: Params = [["_patient", "p1"], ["_count", "2"]]

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const version = (type: string, id: string): Version => ({
  type,
  id,
  versionId: 1,
  lastUpdated: "2024-01-01T00:00:00.000Z",
  deleted: false,
  body: { resourceType: type, id }
})

describe("page size", () => {
  it("defaults when none is asked for", async () => {
    expect(await run(sized(undefined))).toBe(PAGE)
  })

  it("takes a size within the bound", async () => {
    expect(await run(sized(10))).toBe(10)
    expect(await run(sized(MOST))).toBe(MOST)
  })

  it("refuses a size that is not a whole page count", async () => {
    expect(tag(await exit(sized(0)))).toBe("Rejected")
    expect(tag(await exit(sized(1.5)))).toBe("Rejected")
    expect(tag(await exit(sized(MOST + 1)))).toBe("Rejected")
  })
})

describe("position", () => {
  it("starts at the beginning without a token", async () => {
    expect(await run(at("$everything", params, undefined, 5))).toEqual({ offset: 0, limit: 5 })
  })

  it("resumes where a token was issued", async () => {
    const token = issue({ type: "$everything", parameters: params, offset: 4 })
    expect(await run(at("$everything", params, token, 5))).toEqual({ offset: 4, limit: 5 })
  })

  it("refuses a token that was altered", async () => {
    const token = issue({ type: "$everything", parameters: params, offset: 4 })
    const altered = `${token.slice(0, -2)}${token.endsWith("aa") ? "bb" : "aa"}`
    expect(tag(await exit(at("$everything", params, altered, 5)))).toBe("Rejected")
  })

  it("refuses a token issued for another operation", async () => {
    const token = issue({ type: "$includes", parameters: params, offset: 4 })
    expect(tag(await exit(at("$everything", params, token, 5)))).toBe("Rejected")
  })
})

const BASE = "Patient/p1/$everything"

const built = (limit: number, total: number, found: ReadonlyArray<Version>) =>
  pageOf("$everything", BASE, params, { offset: 0, limit }, total, found)

describe("page", () => {
  it("names itself and what it holds", () => {
    const made = built(2, 2, [version("Observation", "o1"), version("Condition", "c1")])
    expect(made.resourceType).toBe("Bundle")
    expect(made.type).toBe("searchset")
    expect(made.total).toBe(2)
    expect(made.entry.map((one) => one.fullUrl)).toEqual([
      "Observation/o1",
      "Condition/c1"
    ])
    expect(made.entry[0]?.resource.resourceType).toBe("Observation")
  })

  it("carries a self link that repeats the request", () => {
    const self = built(2, 2, []).link.find((one) => one.relation === "self")
    expect(self?.url).toBe(`${BASE}?_patient=p1&_count=2`)
  })

  it("offers no next link when the page is the last one", () => {
    const made = built(2, 2, [version("Observation", "o1"), version("Condition", "c1")])
    expect(made.link.some((one) => one.relation === "next")).toBe(false)
  })

  it("offers a next link that resumes the same request", async () => {
    const made = built(1, 3, [version("Observation", "o1")])
    const next = made.link.find((one) => one.relation === "next")?.url
    expect(next).toBeDefined()
    const search = new URLSearchParams(String(next).split("?")[1])
    expect(search.get("_patient")).toBe("p1")
    const token = search.get("_ct")
    expect(token).not.toBeNull()
    const held = await run(at("$everything", params, String(token), 1))
    expect(held).toEqual({ offset: 1, limit: 1 })
  })
})

describe("cut", () => {
  it("takes the window the position asks for", () => {
    expect(cut([1, 2, 3, 4, 5], { offset: 1, limit: 2 })).toEqual([2, 3])
    expect(cut([1, 2, 3], { offset: 5, limit: 2 })).toEqual([])
  })
})
