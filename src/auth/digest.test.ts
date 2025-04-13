import { describe, expect, it } from "vitest"
import { digest, same } from "./digest.js"

describe("digest", () => {
  it("is stable, fixed width and unlike the value", () => {
    expect(digest("secret")).toBe(digest("secret"))
    expect(digest("secret")).toHaveLength(64)
    expect(digest("secret")).not.toContain("secret")
  })

  it("differs for a different value", () => {
    expect(digest("a")).not.toBe(digest("b"))
  })
})

describe("comparison", () => {
  it("holds for equal values of any length", () => {
    expect(same("a", "a")).toBe(true)
    expect(same("a-much-longer-value", "a-much-longer-value")).toBe(true)
  })

  it("fails for values of different length without throwing", () => {
    expect(same("a", "ab")).toBe(false)
    expect(same("", "b")).toBe(false)
  })
})
