import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Rejected } from "../core/outcome.js"
import { parseIdentifier, parseOfType, parseValue, splitOr, unescape } from "./value.js"
import type { Component, Value, ValueType } from "./tree.js"

const ok = (
  valueType: ValueType,
  raw: string,
  components: ReadonlyArray<Component> = []
): Value => {
  const exit = Effect.runSyncExit(parseValue(valueType, raw, "p", components))
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a value for ${raw}`)
}

const why = <A>(effect: Effect.Effect<A, unknown>): string => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    const error = exit.cause.error
    if (error instanceof Rejected) return error.reason
  }
  throw new Error("expected a refusal")
}

const bad = (valueType: ValueType, raw: string, components: ReadonlyArray<Component> = []) =>
  why(parseValue(valueType, raw, "p", components))

const quantityParts: ReadonlyArray<Component> = [
  { name: "code", valueType: "token" },
  { name: "value", valueType: "quantity" }
]

describe("value syntax", () => {
  it("splits a comma list into alternatives", () => {
    expect(splitOr("a,b,c")).toEqual(["a", "b", "c"])
    expect(splitOr("a")).toEqual(["a"])
  })

  it("keeps an escaped comma inside one alternative", () => {
    const parts = splitOr("Simpson\\, Homer,Flanders")
    expect(parts).toHaveLength(2)
    expect(unescape(parts[0] ?? "")).toBe("Simpson, Homer")
  })

  it("unescapes the separators the specification escapes", () => {
    expect(unescape("a\\|b")).toBe("a|b")
    expect(unescape("a\\$b")).toBe("a$b")
    expect(unescape("a\\\\b")).toBe("a\\b")
    expect(unescape("trailing\\")).toBe("trailing\\")
  })
})

describe("number values", () => {
  it("reads a plain number as an equality", () => {
    const value = ok("number", "5")
    expect(value).toMatchObject({ kind: "number", prefix: "eq", value: 5 })
  })

  it("reads every ordered prefix", () => {
    for (const prefix of ["eq", "ne", "gt", "lt", "ge", "le", "sa", "eb", "ap"]) {
      expect(ok("number", `${prefix}5.5`)).toMatchObject({ prefix, value: 5.5 })
    }
  })

  it("reads an exponent and a sign", () => {
    expect(ok("number", "-1.5e2")).toMatchObject({ value: -150 })
  })

  it("refuses text that is not a number, naming the parameter", () => {
    expect(bad("number", "several")).toContain("p")
    expect(bad("number", "gt")).toContain("p")
  })
})

describe("date values", () => {
  it("reads a year as the range it covers", () => {
    expect(ok("date", "2013")).toMatchObject({
      kind: "date",
      prefix: "eq",
      precision: "year",
      start: "2013-01-01T00:00:00.000Z",
      end: "2014-01-01T00:00:00.000Z"
    })
  })

  it("reads a month as the range it covers", () => {
    expect(ok("date", "2013-01")).toMatchObject({
      precision: "month",
      start: "2013-01-01T00:00:00.000Z",
      end: "2013-02-01T00:00:00.000Z"
    })
  })

  it("reads a day as the range it covers", () => {
    expect(ok("date", "2013-01-14")).toMatchObject({
      precision: "day",
      start: "2013-01-14T00:00:00.000Z",
      end: "2013-01-15T00:00:00.000Z"
    })
  })

  it("reads a minute and a second as the ranges they cover", () => {
    expect(ok("date", "2013-01-14T10:00Z")).toMatchObject({
      precision: "minute",
      start: "2013-01-14T10:00:00.000Z",
      end: "2013-01-14T10:01:00.000Z"
    })
    expect(ok("date", "2013-01-14T10:00:30Z")).toMatchObject({
      precision: "second",
      start: "2013-01-14T10:00:30.000Z",
      end: "2013-01-14T10:00:31.000Z"
    })
  })

  it("reads an instant as the millisecond it covers", () => {
    expect(ok("date", "2013-01-14T10:00:30.250Z")).toMatchObject({
      precision: "instant",
      start: "2013-01-14T10:00:30.250Z",
      end: "2013-01-14T10:00:30.251Z"
    })
  })

  it("moves an offset onto the same scale", () => {
    expect(ok("date", "2013-01-14T10:00:00+01:00")).toMatchObject({
      start: "2013-01-14T09:00:00.000Z"
    })
  })

  it("crosses a year and a leap day correctly", () => {
    expect(ok("date", "2013-12")).toMatchObject({ end: "2014-01-01T00:00:00.000Z" })
    expect(ok("date", "2016-02-28")).toMatchObject({ end: "2016-02-29T00:00:00.000Z" })
  })

  it("keeps the prefix with the range", () => {
    expect(ok("date", "ge2013")).toMatchObject({ prefix: "ge", precision: "year" })
    expect(ok("date", "eb2013-01-14")).toMatchObject({ prefix: "eb", precision: "day" })
  })

  it("refuses a date it cannot read", () => {
    expect(bad("date", "yesterday")).toContain("p")
    expect(bad("date", "2013-13")).toContain("p")
    expect(bad("date", "2013-02-30")).toContain("p")
  })
})

describe("string values", () => {
  it("carries the text with its escapes resolved", () => {
    expect(ok("string", "Simpson\\,Homer")).toMatchObject({
      kind: "string",
      text: "Simpson,Homer"
    })
  })

  it("does not read a prefix off a string", () => {
    expect(ok("string", "german")).toMatchObject({ text: "german" })
  })
})

describe("token values", () => {
  it("reads a bare code as any system", () => {
    expect(ok("token", "male")).toMatchObject({
      kind: "token",
      system: undefined,
      code: "male",
      anySystem: true
    })
  })

  it("reads a system and a code", () => {
    expect(ok("token", "http://terms.example|male")).toMatchObject({
      system: "http://terms.example",
      code: "male",
      anySystem: false
    })
  })

  it("reads a leading bar as a code with no system", () => {
    expect(ok("token", "|male")).toMatchObject({
      system: undefined,
      code: "male",
      anySystem: false
    })
  })

  it("reads a trailing bar as any code in a system", () => {
    expect(ok("token", "http://terms.example|")).toMatchObject({
      system: "http://terms.example",
      code: undefined,
      anySystem: false
    })
  })

  it("carries a token far longer than any index width in full", () => {
    const long = "z".repeat(5000)
    const value = ok("token", `http://terms.example|${long}`)
    expect(value).toMatchObject({ system: "http://terms.example" })
    expect(value.kind === "token" ? value.code : "").toHaveLength(5000)
    expect(value.kind === "token" ? value.code : "").toBe(long)
  })

  it("refuses a bare bar and a token of three parts", () => {
    expect(bad("token", "|")).toContain("p")
    expect(bad("token", "a|b|c")).toContain("p")
  })
})

describe("quantity values", () => {
  it("reads a value, a system and a code", () => {
    expect(ok("quantity", "5.4|http://units.example|mg")).toMatchObject({
      kind: "quantity",
      prefix: "eq",
      value: 5.4,
      system: "http://units.example",
      code: "mg"
    })
  })

  it("reads a prefix on a quantity", () => {
    expect(ok("quantity", "gt5.4|http://units.example|mg")).toMatchObject({
      prefix: "gt",
      value: 5.4
    })
  })

  it("reads a quantity with no system", () => {
    expect(ok("quantity", "5.4||mg")).toMatchObject({ system: undefined, code: "mg" })
  })

  it("reads a bare number as a quantity with no unit", () => {
    expect(ok("quantity", "5.4")).toMatchObject({ value: 5.4, system: undefined, code: undefined })
  })

  it("refuses a quantity it cannot read", () => {
    expect(bad("quantity", "heavy|http://units.example|mg")).toContain("p")
    expect(bad("quantity", "5.4|mg")).toContain("p")
  })
})

describe("reference values", () => {
  it("reads a bare id", () => {
    expect(ok("reference", "p1")).toMatchObject({
      kind: "reference",
      ref: { form: "id", id: "p1" }
    })
  })

  it("reads a type and an id", () => {
    expect(ok("reference", "Patient/p1")).toMatchObject({
      ref: { form: "typed", type: "Patient", id: "p1" }
    })
  })

  it("reads an absolute address", () => {
    expect(ok("reference", "https://elsewhere.example/fhir/Patient/p1")).toMatchObject({
      ref: { form: "url", url: "https://elsewhere.example/fhir/Patient/p1" }
    })
  })

  it("refuses a reference it cannot read", () => {
    expect(bad("reference", "not a reference")).toContain("p")
  })

  it("reads an identifier reference as a token", () => {
    const exit = Effect.runSyncExit(parseIdentifier("http://ids.example|7", "p"))
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toMatchObject({
      kind: "reference",
      ref: { form: "identifier", system: "http://ids.example", code: "7", anySystem: false }
    })
  })

  it("refuses an identifier reference it cannot read", () => {
    expect(why(parseIdentifier("|", "p"))).toContain("p")
  })
})

describe("uri values", () => {
  it("carries the address whole", () => {
    expect(ok("uri", "http://profiles.example/StructureDefinition/x")).toMatchObject({
      kind: "uri",
      value: "http://profiles.example/StructureDefinition/x"
    })
  })

  it("refuses an empty address", () => {
    expect(bad("uri", "")).toContain("p")
  })
})

describe("of-type values", () => {
  it("reads a system, a code and a value", () => {
    const exit = Effect.runSyncExit(parseOfType("http://ids.example|MR|446053", "p"))
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toMatchObject({
      kind: "of-type",
      system: "http://ids.example",
      code: "MR",
      value: "446053"
    })
  })

  it("refuses anything but three parts", () => {
    expect(why(parseOfType("http://ids.example|MR", "p"))).toContain("p")
    expect(why(parseOfType("http://ids.example||446053", "p"))).toContain("p")
  })
})

describe("composite values", () => {
  it("reads one part per declared component", () => {
    const value = ok("composite", "http://loinc.example|8480-6$gt60", quantityParts)
    expect(value.kind).toBe("composite")
    const parts = value.kind === "composite" ? value.parts : []
    expect(parts[0]).toMatchObject({ kind: "token", code: "8480-6" })
    expect(parts[1]).toMatchObject({ kind: "quantity", prefix: "gt", value: 60 })
  })

  it("refuses a part count that does not match the declaration", () => {
    expect(bad("composite", "http://loinc.example|8480-6", quantityParts)).toContain("p")
  })

  it("refuses a component it cannot read", () => {
    expect(bad("composite", "http://loinc.example|8480-6$heavy", quantityParts)).toContain("p")
  })
})
