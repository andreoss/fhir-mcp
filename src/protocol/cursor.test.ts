import { describe, expect, it } from "vitest"
import { PAGE_SIZE, paginate } from "./cursor.js"

const items = [...Array(12).keys()].map(String)

describe("protocol cursors", () => {
  it("serves the default page size and a next cursor", () => {
    const first = paginate(items, undefined, "type")
    expect(first?.page).toEqual(items.slice(0, PAGE_SIZE))
    expect(first?.nextCursor).toBeDefined()
  })

  it("continues from a cursor with the next page", () => {
    const first = paginate(items, undefined, "type")
    const second = paginate(items, first?.nextCursor, "type")
    expect(second?.page).toEqual(items.slice(PAGE_SIZE, PAGE_SIZE * 2))
  })

  it("walks to the end and then stops", () => {
    let after: string | undefined
    let seen = 0
    for (let i = 0; i < 10; i++) {
      const part = paginate(items, after, "type")
      if (part === undefined) break
      seen += part.page.length
      if (part.nextCursor === undefined) break
      after = part.nextCursor
    }
    expect(seen).toBe(items.length)
  })

  it("refuses a cursor from another scope", () => {
    const first = paginate(items, undefined, "type")
    expect(paginate(items, first?.nextCursor, "other")).toBeUndefined()
  })

  it("refuses a tampered cursor", () => {
    const first = paginate(items, undefined, "type")
    const next = first?.nextCursor ?? ""
    const flipped = next[4] === "A" ? "B" : "A"
    const tampered = next.slice(0, 4) + flipped + next.slice(5)
    expect(paginate(items, tampered, "type")).toBeUndefined()
  })

  it("refuses a cursor that is not signed", () => {
    expect(paginate(items, "ZGF0YQ.Zn3_fake", "type")).toBeUndefined()
  })
})