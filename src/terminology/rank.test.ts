import { describe, expect, it } from "vitest"
import { order } from "./rank.js"
import type { Rankable } from "./rank.js"

const concept = (
  code: string,
  display: string | undefined,
  extra: Partial<Rankable> = {}
): Rankable => ({ code, ...(display === undefined ? {} : { display }), ...extra })

describe("ranked text search", () => {
  it("orders an exact display match before a prefix and a substring", () => {
    const items = [
      concept("a", "Iron anemia"),
      concept("anemia", "Anemia"),
      concept("anem", "Anemia panel")
    ]
    const found = order("anemia", items)
    expect(found._tag).toBe("ranked")
    if (found._tag !== "ranked") return
    expect(found.criterion).toBe("relevance")
    expect(found.entries.map((one) => one.code)).toEqual(["anemia", "anem", "a"])
  })

  it("names the ranking and carries a rank and a score", () => {
    const found = order("anemia", [concept("a", "Anemia test")])
    expect(found._tag).toBe("ranked")
    if (found._tag !== "ranked") return
    expect(found.entries[0]?.rank).toBe(1)
    expect(found.entries[0]?.score).toBeGreaterThan(0)
  })

  it("ranks a display match above a code-only match", () => {
    const items = [concept("cat", undefined), concept("c", "Cat")]
    const found = order("cat", items)
    expect(found._tag).toBe("ranked")
    if (found._tag !== "ranked") return
    expect(found.entries.map((one) => one.code)).toEqual(["c", "cat"])
  })

  it("breaks a score tie by shorter display and then by code", () => {
    const items = [concept("b", "Copper anvil"), concept("a", "Canine")]
    const found = order("an", items)
    expect(found._tag).toBe("ranked")
    if (found._tag !== "ranked") return
    expect(found.entries.map((one) => one.code)).toEqual(["a", "b"])
  })

  it("matches without regard to case", () => {
    const items = [concept("x", "HELLO WORLD"), concept("y", "goodbye")]
    const found = order("hello", items)
    expect(found._tag).toBe("ranked")
    if (found._tag !== "ranked") return
    expect(found.entries.map((one) => one.code)).toEqual(["x", "y"])
    expect(found.entries[1]?.score).toBe(0)
  })

  it("orders a list an unranked source sends without implying an order", () => {
    const items = [concept("a", "A"), concept("b", "B")]
    const found = order(undefined, items)
    expect(found._tag).toBe("unranked")
    if (found._tag !== "unranked") return
    expect(found.entries.map((one) => one.code)).toEqual(["a", "b"])
    for (const one of found.entries) {
      expect("rank" in one).toBe(false)
      expect("score" in one).toBe(false)
    }
  })

  it("treats an empty query as unranked", () => {
    expect(order("", [concept("a", "A")])._tag).toBe("unranked")
  })
})