import { describe, expect, it } from "vitest"
import { page, split } from "./chunk.js"

const text = "abcdefghij".repeat(10)

describe("offset-addressed chunking", () => {
  it("returns one chunk when the text fits the budget", () => {
    expect(split("hello", 100)).toEqual([{ offset: 0, length: 5, text: "hello" }])
  })

  it("splits long text into addressed chunks that rebuild it exactly", () => {
    const chunks = split(text, 7)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((one) => one.text.length <= 7)).toBe(true)
    expect(chunks.map((one) => one.text).join("")).toBe(text)
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1]
      const current = chunks[i]
      expect(current?.offset).toBe((prev?.offset ?? 0) + (prev?.length ?? 0))
    }
  })

  it("gives the same boundaries for the same input", () => {
    expect(split(text, 9).map((one) => [one.offset, one.length]))
      .toEqual(split(text, 9).map((one) => [one.offset, one.length]))
    expect(split(text, 9).map((one) => [one.offset, one.length]))
      .not.toEqual(split(text, 10).map((one) => [one.offset, one.length]))
  })

  it("does not split a surrogate pair across chunks", () => {
    const both = "ab" + "x\u{1F600}y"
    const chunks = split(both, 2)
    expect(chunks.map((one) => one.text).join("")).toBe(both)
    expect(chunks.some((one) => one.text === "\uD83D")).toBe(false)
    expect(chunks.some((one) => one.text === "\uDE00")).toBe(false)
  })

  it("needs a budget of at least one character", () => {
    expect(() => split("abc", 0)).not.toThrow()
    expect(split("abc", 1).map((one) => one.text)).toEqual(["a", "b", "c"])
  })
})

describe("paging addressed chunks", () => {
  const chunks = split(text, 10)

  it("hands back the first chunk and counts what it withheld", () => {
    const held = page(chunks, 0, 1)
    expect(held.total).toBe(chunks.length)
    expect(held.chunks).toHaveLength(1)
    expect(held.chunks[0]?.offset).toBe(0)
    expect(held.withheld).toBe(chunks.length - 1)
  })

  it("continues from an offset the previous answer named", () => {
    const held = page(chunks, 3, 2)
    expect(held.chunks.map((one) => one.offset)).toEqual([30, 40])
    expect(held.withheld).toBe(chunks.length - 2)
  })

  it("reports everything withheld when the offset is past the end", () => {
    const held = page(chunks, 999, 2)
    expect(held.chunks).toEqual([])
    expect(held.withheld).toBe(chunks.length)
  })

  it("pages deterministically for the same offset and window", () => {
    expect(page(chunks, 4, 3)).toEqual(page(chunks, 4, 3))
    expect(page(chunks, 4, 3).chunks.map((one) => one.offset)).not.toEqual(
      page(chunks, 5, 3).chunks.map((one) => one.offset)
    )
  })
})