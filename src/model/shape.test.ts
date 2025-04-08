import { describe, expect, it } from "vitest"
import { el, group, matches, open, repeats, required } from "./shape.js"

describe("element format", () => {
  it("gives an element a kind and a default cardinality of 0..1", () => {
    expect(el("string")).toEqual({ kind: "string", card: "0..1" })
  })

  it("carries the cardinality it is given", () => {
    expect(el("code", "1..1").card).toBe("1..1")
  })

  it("nests children under a group", () => {
    const name = group({ family: el("string") }, "0..*")
    expect(name.kind).toBe("group")
    expect(name.card).toBe("0..*")
    expect(name.children["family"]).toEqual({ kind: "string", card: "0..1" })
  })

  it("defaults a group to 0..1", () => {
    expect(group({}).card).toBe("0..1")
  })

  it("reads repetition from the cardinality", () => {
    expect(repeats("0..*")).toBe(true)
    expect(repeats("1..*")).toBe(true)
    expect(repeats("0..1")).toBe(false)
    expect(repeats("1..1")).toBe(false)
  })

  it("reads requirement from the cardinality", () => {
    expect(required("1..1")).toBe(true)
    expect(required("1..*")).toBe(true)
    expect(required("0..1")).toBe(false)
    expect(required("0..*")).toBe(false)
  })
})

describe("primitive shapes", () => {
  it("accepts text with content as a string", () => {
    expect(matches("string", "Simpson")).toBe(true)
    expect(matches("string", "")).toBe(false)
    expect(matches("string", "   ")).toBe(false)
    expect(matches("string", 7)).toBe(false)
  })

  it("accepts only a boolean as a boolean", () => {
    expect(matches("boolean", true)).toBe(true)
    expect(matches("boolean", false)).toBe(true)
    expect(matches("boolean", "true")).toBe(false)
  })

  it("accepts a whole number as an integer", () => {
    expect(matches("integer", 7)).toBe(true)
    expect(matches("integer", -7)).toBe(true)
    expect(matches("integer", 7.5)).toBe(false)
    expect(matches("integer", "7")).toBe(false)
  })

  it("accepts a finite number as a decimal", () => {
    expect(matches("decimal", 7.5)).toBe(true)
    expect(matches("decimal", 7)).toBe(true)
    expect(matches("decimal", Number.POSITIVE_INFINITY)).toBe(false)
    expect(matches("decimal", Number.NaN)).toBe(false)
  })

  it("accepts a year, a year-month or a full date as a date", () => {
    expect(matches("date", "1956")).toBe(true)
    expect(matches("date", "1956-05")).toBe(true)
    expect(matches("date", "1956-05-12")).toBe(true)
    expect(matches("date", "12/05/1956")).toBe(false)
    expect(matches("date", "1956-05-12T00:00:00Z")).toBe(false)
  })

  it("refuses a date that is well formed but impossible", () => {
    expect(matches("date", "1956-13-01")).toBe(false)
    expect(matches("date", "1956-00-01")).toBe(false)
    expect(matches("date", "1956-02-31")).toBe(false)
    expect(matches("date", "1956-04-31")).toBe(false)
    expect(matches("date", "1956-01-32")).toBe(false)
    expect(matches("date", "1956-01-00")).toBe(false)
  })

  it("counts the days of february by the year", () => {
    expect(matches("date", "1956-02-29")).toBe(true)
    expect(matches("date", "1957-02-29")).toBe(false)
    expect(matches("date", "2000-02-29")).toBe(true)
    expect(matches("date", "1900-02-29")).toBe(false)
  })

  it("accepts a date or a stamped time as a dateTime", () => {
    expect(matches("dateTime", "1956")).toBe(true)
    expect(matches("dateTime", "1956-05-12")).toBe(true)
    expect(matches("dateTime", "1956-05-12T08:30:00Z")).toBe(true)
    expect(matches("dateTime", "1956-05-12T08:30:00.25+02:00")).toBe(true)
    expect(matches("dateTime", "1956-05-12T08:30")).toBe(false)
    expect(matches("dateTime", "1956-05-12T08:30:00")).toBe(false)
    expect(matches("dateTime", "1956-02-31T08:30:00Z")).toBe(false)
    expect(matches("dateTime", "1956-05-12T25:30:00Z")).toBe(false)
    expect(matches("dateTime", "1956-05-12T08:61:00Z")).toBe(false)
    expect(matches("dateTime", "1956-05-12T08:30:99Z")).toBe(false)
  })

  it("requires a full stamp with an offset for an instant", () => {
    expect(matches("instant", "1956-05-12T08:30:00Z")).toBe(true)
    expect(matches("instant", "1956-05-12T08:30:00.123-05:00")).toBe(true)
    expect(matches("instant", "1956-05-12")).toBe(false)
    expect(matches("instant", "1956-05-12T08:30:00")).toBe(false)
    expect(matches("instant", "1956-02-30T08:30:00Z")).toBe(false)
  })

  it("accepts text without space as a uri", () => {
    expect(matches("uri", "http://example.org/fhir")).toBe(true)
    expect(matches("uri", "urn:oid:1.2.3")).toBe(true)
    expect(matches("uri", "two words")).toBe(false)
    expect(matches("uri", "")).toBe(false)
  })

  it("accepts a single-spaced token as a code", () => {
    expect(matches("code", "final")).toBe(true)
    expect(matches("code", "vital signs")).toBe(true)
    expect(matches("code", " final")).toBe(false)
    expect(matches("code", "final ")).toBe(false)
    expect(matches("code", "vital  signs")).toBe(false)
    expect(matches("code", "")).toBe(false)
  })

  it("accepts the allowed characters as an id", () => {
    expect(matches("id", "p1")).toBe(true)
    expect(matches("id", "a-b.c")).toBe(true)
    expect(matches("id", "p 1")).toBe(false)
    expect(matches("id", "p_1")).toBe(false)
    expect(matches("id", "")).toBe(false)
    expect(matches("id", "x".repeat(65))).toBe(false)
  })
})

describe("open content", () => {
  it("declares an element whose content is not walked", () => {
    expect(open("0..*")).toEqual({ kind: "open", card: "0..*" })
  })

  it("defaults open content to 0..1", () => {
    expect(open().card).toBe("0..1")
  })
})
