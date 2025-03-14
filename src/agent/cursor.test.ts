import { describe, expect, it } from "vitest"
import { issue, redeem } from "./cursor.js"

const position = { type: "Patient", parameters: [["family", "Simpson"]] as ReadonlyArray<readonly [string, string]>, offset: 25 }

describe("continuation token", () => {
  it("hands back the position it was issued for", () => {
    const token = issue(position)
    expect(redeem(token, position.type, position.parameters)).toEqual({ offset: 25 })
  })

  it("says nothing about the query in the token text", () => {
    expect(issue(position)).not.toContain("Simpson")
    expect(issue(position)).not.toContain("Patient")
    expect(issue(position)).not.toContain("25")
  })

  it("refuses a token whose text was altered", () => {
    const token = issue(position)
    const altered = `${token.slice(0, -2)}${token.endsWith("aa") ? "bb" : "aa"}`
    expect(redeem(altered, position.type, position.parameters)).toBeUndefined()
  })

  it("refuses a token presented against a different query", () => {
    const token = issue(position)
    expect(redeem(token, "Observation", position.parameters)).toBeUndefined()
    expect(redeem(token, position.type, [["family", "Flanders"]])).toBeUndefined()
  })

  it("refuses text that was never a token", () => {
    expect(redeem("not-a-token", position.type, position.parameters)).toBeUndefined()
    expect(redeem("", position.type, position.parameters)).toBeUndefined()
  })

  it("issues a different token for a different position", () => {
    expect(issue(position)).not.toBe(issue({ ...position, offset: 50 }))
  })

  it("does not care in which order the parameters were given", () => {
    const token = issue({ type: "Patient", parameters: [["a", "1"], ["b", "2"]], offset: 10 })
    expect(redeem(token, "Patient", [["b", "2"], ["a", "1"]])).toEqual({ offset: 10 })
  })
})

describe("continuation token, refused shapes", () => {
  it("refuses a token carrying more parts than it should", () => {
    expect(redeem("a.b.c", position.type, position.parameters)).toBeUndefined()
  })

  it("refuses a token whose payload is not readable", () => {
    const broken = "!!!not-base64!!!"
    expect(redeem(`${broken}.${issue(position).split(".")[1]}`, position.type, position.parameters))
      .toBeUndefined()
  })

  it("refuses a seal of the wrong length", () => {
    const token = issue(position)
    expect(redeem(`${token.split(".")[0]}.short`, position.type, position.parameters)).toBeUndefined()
  })
})
