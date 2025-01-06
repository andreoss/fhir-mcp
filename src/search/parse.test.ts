import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Rejected } from "../core/outcome.js"
import { parse } from "./parse.js"
import type { Query } from "./parse.js"
import type { Chain, Compare, Expr, Has, Missing } from "./tree.js"

const ok = (type: string, entries: ReadonlyArray<readonly [string, string]>): Query => {
  const exit = Effect.runSyncExit(parse(type, entries))
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected a query")
}

const bad = (type: string, entries: ReadonlyArray<readonly [string, string]>): string => {
  const exit = Effect.runSyncExit(parse(type, entries))
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    const error = exit.cause.error
    if (error instanceof Rejected) return error.reason
  }
  throw new Error("expected a refusal")
}

const one = (type: string, name: string, value: string): Expr => {
  const found = ok(type, [[name, value]]).expr
  if (found === undefined) throw new Error("expected an expression")
  return found
}

const compare = (type: string, name: string, value: string): Compare => {
  const node = one(type, name, value)
  if (node.kind !== "compare") throw new Error("expected a comparison")
  return node
}

const chain = (type: string, name: string, value: string): Chain => {
  const node = one(type, name, value)
  if (node.kind !== "chain") throw new Error("expected a chain")
  return node
}

const has = (type: string, name: string, value: string): Has => {
  const node = one(type, name, value)
  if (node.kind !== "has") throw new Error("expected a reverse chain")
  return node
}

const missing = (type: string, name: string, value: string): Missing => {
  const node = one(type, name, value)
  if (node.kind !== "missing") throw new Error("expected a missing test")
  return node
}

describe("parsing a query", () => {
  it("carries the type and no expression when nothing is asked", () => {
    const query = ok("Patient", [])
    expect(query.type).toBe("Patient")
    expect(query.expr).toBeUndefined()
  })

  it("refuses a type that is not served", () => {
    expect(bad("Sasquatch", [])).toContain("Sasquatch")
  })

  it("reads one parameter as one comparison", () => {
    expect(compare("Patient", "family", "Simpson")).toMatchObject({
      kind: "compare",
      type: "Patient",
      param: "family",
      valueType: "string",
      modifier: undefined,
      value: { kind: "string", text: "Simpson" }
    })
  })

  it("joins repeated parameters with and", () => {
    const query = ok("Patient", [
      ["family", "Simpson"],
      ["given", "Homer"]
    ])
    expect(query.expr?.kind).toBe("and")
    const terms = query.expr?.kind === "and" ? query.expr.terms : []
    expect(terms).toHaveLength(2)
    expect(terms.every((term) => term.kind === "compare")).toBe(true)
  })

  it("joins the values of one parameter with or", () => {
    const node = one("Patient", "family", "Simpson,Flanders")
    expect(node.kind).toBe("or")
    const terms = node.kind === "or" ? node.terms : []
    expect(terms).toHaveLength(2)
    expect(terms[0]).toMatchObject({ value: { text: "Simpson" } })
    expect(terms[1]).toMatchObject({ value: { text: "Flanders" } })
  })

  it("joins repeated parameters of the same name with and", () => {
    const query = ok("Patient", [
      ["family", "Simpson"],
      ["family", "Flanders"]
    ])
    expect(query.expr?.kind).toBe("and")
  })

  it("keeps an escaped comma inside one value", () => {
    expect(compare("Patient", "family", "Simpson\\,Homer")).toMatchObject({
      value: { text: "Simpson,Homer" }
    })
  })
})

describe("common parameters", () => {
  it("reads the common parameters on any served type", () => {
    expect(compare("Patient", "_id", "p1").valueType).toBe("token")
    expect(compare("Patient", "_lastUpdated", "ge2013").valueType).toBe("date")
    expect(compare("Observation", "_profile", "http://profiles.example/x").valueType).toBe("uri")
    expect(compare("Observation", "_tag", "http://tags.example|urgent").valueType).toBe("token")
    expect(compare("Encounter", "_security", "R").valueType).toBe("token")
    expect(compare("Encounter", "_list", "42").valueType).toBe("string")
    expect(compare("Condition", "_type", "Condition").valueType).toBe("token")
  })
})

describe("value types", () => {
  it("reads every declared value type", () => {
    expect(compare("Patient", "family", "Simpson").value.kind).toBe("string")
    expect(compare("Patient", "birthdate", "1956").value.kind).toBe("date")
    expect(compare("Patient", "gender", "male").value.kind).toBe("token")
    expect(compare("Encounter", "length", "gt30").value.kind).toBe("number")
    expect(compare("Observation", "value-quantity", "gt5.4|http://units.example|mg").value.kind)
      .toBe("quantity")
    expect(compare("Observation", "patient", "Patient/p1").value.kind).toBe("reference")
    expect(compare("Observation", "_profile", "http://profiles.example/x").value.kind).toBe("uri")
    expect(
      compare("Observation", "code-value-quantity", "http://loinc.example|8480-6$gt60").value.kind
    ).toBe("composite")
  })

  it("compares a date against the range its precision defines", () => {
    const node = compare("Patient", "birthdate", "1956")
    expect(node.value).toMatchObject({
      precision: "year",
      start: "1956-01-01T00:00:00.000Z",
      end: "1957-01-01T00:00:00.000Z"
    })
  })

  it("keeps a prefix on an ordered type", () => {
    expect(compare("Patient", "birthdate", "ge1956").value).toMatchObject({ prefix: "ge" })
    expect(compare("Encounter", "length", "lt30").value).toMatchObject({ prefix: "lt" })
  })

  it("does not read a prefix off a token", () => {
    expect(compare("Patient", "gender", "germ").value).toMatchObject({ code: "germ" })
  })

  it("refuses a value the type cannot read, naming the parameter", () => {
    expect(bad("Patient", [["birthdate", "yesterday"]])).toContain("birthdate")
    expect(bad("Encounter", [["length", "long"]])).toContain("length")
  })

  it("matches a token longer than any index width by carrying it whole", () => {
    const long = "q".repeat(4096)
    const node = compare("Patient", "identifier", `http://ids.example|${long}`)
    const value = node.value
    expect(value.kind).toBe("token")
    const code = value.kind === "token" ? value.code : undefined
    expect(code).toHaveLength(4096)
    expect(code).toBe(long)
  })
})

describe("modifiers", () => {
  it("reads a missing test on either side", () => {
    expect(missing("Patient", "family:missing", "true")).toMatchObject({
      kind: "missing",
      type: "Patient",
      param: "family",
      present: false
    })
    expect(missing("Patient", "family:missing", "false").present).toBe(true)
  })

  it("refuses a missing test that is neither true nor false", () => {
    expect(bad("Patient", [["family:missing", "perhaps"]])).toContain("missing")
  })

  it("reads exact and contains on a string", () => {
    expect(compare("Patient", "family:exact", "Simpson").modifier).toBe("exact")
    expect(compare("Patient", "family:contains", "imps").modifier).toBe("contains")
  })

  it("reads not, text, in, not-in, below and above on a token", () => {
    expect(compare("Observation", "code:not", "1234-5").modifier).toBe("not")
    expect(compare("Observation", "code:below", "1234-5").modifier).toBe("below")
    expect(compare("Observation", "code:above", "1234-5").modifier).toBe("above")
    const text = compare("Observation", "code:text", "blood pressure")
    expect(text.modifier).toBe("text")
    expect(text.value.kind).toBe("string")
    const inside = compare("Observation", "code:in", "http://valuesets.example/vs")
    expect(inside.modifier).toBe("in")
    expect(inside.value.kind).toBe("uri")
    expect(compare("Observation", "code:not-in", "http://valuesets.example/vs").value.kind)
      .toBe("uri")
  })

  it("reads of-type on a token", () => {
    const node = compare("Patient", "identifier:of-type", "http://ids.example|MR|446053")
    expect(node.modifier).toBe("of-type")
    expect(node.value).toMatchObject({ kind: "of-type", code: "MR", value: "446053" })
  })

  it("reads identifier on a reference", () => {
    const node = compare("Observation", "subject:identifier", "http://ids.example|7")
    expect(node.modifier).toBe("identifier")
    expect(node.value).toMatchObject({ ref: { form: "identifier", code: "7" } })
  })

  it("reads a type modifier on a reference", () => {
    const node = compare("Observation", "subject:Patient", "p1")
    expect(node.modifier).toBe("type")
    expect(node.target).toBe("Patient")
    expect(node.value).toMatchObject({ ref: { form: "id", id: "p1" } })
  })

  it("reads below and above on an address", () => {
    expect(compare("Patient", "_profile:below", "http://profiles.example/").modifier).toBe("below")
  })

  it("refuses a modifier the value type does not carry, naming both", () => {
    const reason = bad("Patient", [["gender:exact", "male"]])
    expect(reason).toContain(":exact")
    expect(reason).toContain("token")
    const other = bad("Patient", [["birthdate:contains", "1956"]])
    expect(other).toContain(":contains")
    expect(other).toContain("date")
  })

  it("refuses a modifier it does not know", () => {
    expect(bad("Patient", [["family:sideways", "x"]])).toContain("sideways")
  })

  it("refuses a type modifier the reference cannot reach", () => {
    expect(bad("Observation", [["patient:Encounter", "e1"]])).toContain("Encounter")
  })

  it("refuses more than one modifier", () => {
    expect(bad("Patient", [["family:exact:contains", "x"]])).toContain("family")
  })
})

describe("unknown and unsupported parameters", () => {
  it("refuses a parameter the type does not declare, naming it", () => {
    const reason = bad("Patient", [["colour", "blue"]])
    expect(reason).toContain("colour")
    expect(reason).toContain("Patient")
  })

  it("refuses free text search explicitly", () => {
    expect(bad("Patient", [["_text", "fever"]])).toContain("_text")
    expect(bad("Patient", [["_text", "fever"]])).toContain("not supported")
    expect(bad("Patient", [["_content", "fever"]])).toContain("_content")
    expect(bad("Patient", [["_filter", "family eq x"]])).toContain("_filter")
  })

  it("refuses an empty value explicitly", () => {
    expect(bad("Patient", [["family", ""]])).toContain("family")
    expect(bad("Patient", [["family", "   "]])).toContain("family")
    expect(bad("Patient", [["family", "Simpson,,Flanders"]])).toContain("family")
  })
})

describe("chaining", () => {
  it("chains through a reference with a single target", () => {
    const node = chain("Observation", "patient.family", "Simpson")
    expect(node).toMatchObject({
      kind: "chain",
      type: "Observation",
      param: "patient",
      target: "Patient"
    })
    expect(node.next).toMatchObject({ kind: "compare", type: "Patient", param: "family" })
  })

  it("chains through a named target when the reference has several", () => {
    const node = chain("Observation", "subject:Patient.family", "Simpson")
    expect(node.target).toBe("Patient")
    expect(node.next).toMatchObject({ type: "Patient", param: "family" })
  })

  it("refuses a chain whose target is ambiguous", () => {
    const reason = bad("Observation", [["subject.family", "Simpson"]])
    expect(reason).toContain("subject")
  })

  it("chains more than one level", () => {
    const node = chain("Observation", "encounter.subject.family", "Simpson")
    expect(node.target).toBe("Encounter")
    const inner = node.next
    expect(inner.kind).toBe("chain")
    if (inner.kind !== "chain") throw new Error("expected a chain")
    expect(inner).toMatchObject({ type: "Encounter", param: "subject", target: "Patient" })
    expect(inner.next).toMatchObject({ kind: "compare", type: "Patient", param: "family" })
  })

  it("carries the alternatives of the value to the far end of the chain", () => {
    const node = chain("Observation", "patient.family", "Simpson,Flanders")
    expect(node.next.kind).toBe("or")
  })

  it("refuses a chain through a parameter that is not a reference", () => {
    expect(bad("Patient", [["family.given", "Homer"]])).toContain("family")
  })

  it("refuses a chain into a type that is not served", () => {
    expect(bad("Observation", [["subject:Device.family", "x"]])).toContain("Device")
  })

  it("refuses a chain onto a parameter the target does not declare", () => {
    expect(bad("Observation", [["patient.colour", "blue"]])).toContain("colour")
  })

  it("refuses a chain with nothing after the dot", () => {
    expect(bad("Observation", [["patient.", "x"]])).toContain("patient")
  })

  it("refuses a chain over a parameter the type does not declare", () => {
    expect(bad("Patient", [["colour.name", "blue"]])).toContain("colour")
  })

  it("refuses a chain naming a type the reference cannot reach", () => {
    expect(bad("Observation", [["patient:Encounter.status", "x"]])).toContain("Encounter")
  })

  it("refuses more than one modifier on a chain", () => {
    expect(bad("Observation", [["subject:Patient:exact.family", "x"]])).toContain("subject")
  })
})

describe("reverse chaining", () => {
  it("reads a reverse chain", () => {
    const node = has("Patient", "_has:Observation:patient:code", "1234-5")
    expect(node).toMatchObject({
      kind: "has",
      type: "Patient",
      source: "Observation",
      ref: "patient"
    })
    expect(node.next).toMatchObject({ kind: "compare", type: "Observation", param: "code" })
  })

  it("reads a reverse chain more than one level deep", () => {
    const node = has("Patient", "_has:Encounter:subject:_has:Observation:encounter:code", "1234-5")
    expect(node.source).toBe("Encounter")
    const inner = node.next
    if (inner.kind !== "has") throw new Error("expected a reverse chain")
    expect(inner).toMatchObject({ type: "Encounter", source: "Observation", ref: "encounter" })
    expect(inner.next).toMatchObject({ kind: "compare", type: "Observation", param: "code" })
  })

  it("reads a chain inside a reverse chain", () => {
    const node = has("Patient", "_has:Observation:patient:encounter.status", "finished")
    expect(node.next.kind).toBe("chain")
  })

  it("keeps a modifier at the end of a reverse chain", () => {
    const node = has("Patient", "_has:Observation:patient:code:text", "blood pressure")
    expect(node.next).toMatchObject({ kind: "compare", modifier: "text" })
  })

  it("refuses a reverse chain of the wrong shape", () => {
    expect(bad("Patient", [["_has:Observation:patient", "x"]])).toContain("_has")
    expect(bad("Patient", [["_has", "x"]])).toContain("_has")
  })

  it("refuses a reverse chain from a type that is not served", () => {
    expect(bad("Patient", [["_has:Sasquatch:patient:code", "x"]])).toContain("Sasquatch")
  })

  it("refuses a reverse chain over a parameter the source does not declare", () => {
    expect(bad("Patient", [["_has:Observation:owner:code", "x"]])).toContain("owner")
  })

  it("refuses a reverse chain over a parameter that is not a reference", () => {
    expect(bad("Patient", [["_has:Observation:status:code", "x"]])).toContain("status")
  })

  it("refuses a reverse chain whose reference does not reach the type searched", () => {
    const reason = bad("Patient", [["_has:Observation:encounter:code", "x"]])
    expect(reason).toContain("encounter")
    expect(reason).toContain("Patient")
  })

  it("refuses a reverse chain onto a parameter the source does not declare", () => {
    expect(bad("Patient", [["_has:Observation:patient:colour", "x"]])).toContain("colour")
  })
})

describe("result control alongside criteria", () => {
  it("keeps control parameters out of the expression", () => {
    const query = ok("Patient", [
      ["family", "Simpson"],
      ["_count", "10"],
      ["_sort", "-birthdate"],
      ["_total", "accurate"],
      ["_elements", "name"],
      ["_summary", "text"],
      ["_include", "Observation:patient"],
      ["_revinclude", "Observation:patient"]
    ])
    expect(query.expr?.kind).toBe("compare")
    expect(query.controls.count).toBe(10)
    expect(query.controls.sort).toEqual([{ name: "birthdate", descending: true }])
    expect(query.controls.total).toBe("accurate")
    expect(query.controls.elements).toEqual(["name"])
    expect(query.controls.summary).toBe("text")
    expect(query.controls.include).toHaveLength(1)
    expect(query.controls.revinclude).toHaveLength(1)
  })

  it("reports a bad control alongside good criteria", () => {
    expect(bad("Patient", [["family", "Simpson"], ["_total", "roughly"]])).toContain("_total")
  })
})
