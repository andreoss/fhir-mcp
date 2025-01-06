import { describe, expect, it } from "vitest"
import { KINDS, fold } from "./tree.js"
import type { Expr, Visitor } from "./tree.js"

const token = (code: string): Expr => ({
  kind: "compare",
  type: "Observation",
  param: "code",
  valueType: "token",
  modifier: undefined,
  target: undefined,
  value: { kind: "token", system: undefined, code, anySystem: true, text: code }
})

const tree: Expr = {
  kind: "and",
  terms: [
    { kind: "or", terms: [token("a"), token("b")] },
    { kind: "missing", type: "Patient", param: "family", present: false },
    {
      kind: "chain",
      type: "Observation",
      param: "patient",
      target: "Patient",
      next: {
        kind: "has",
        type: "Patient",
        source: "Observation",
        ref: "patient",
        next: token("c")
      }
    }
  ]
}

const collect: Visitor<ReadonlyArray<string>> = {
  and: (terms) => ["and", ...terms.flat()],
  or: (terms) => ["or", ...terms.flat()],
  compare: () => ["compare"],
  missing: () => ["missing"],
  chain: (next) => ["chain", ...next],
  has: (next) => ["has", ...next]
}

const count: Visitor<number> = {
  and: (terms) => terms.reduce((a, b) => a + b, 1),
  or: (terms) => terms.reduce((a, b) => a + b, 1),
  compare: () => 1,
  missing: () => 1,
  chain: (next) => next + 1,
  has: (next) => next + 1
}

describe("expression tree", () => {
  it("reaches every node kind it declares", () => {
    expect(new Set(fold(tree, collect))).toEqual(new Set(KINDS))
  })

  it("folds every node exactly once", () => {
    expect(fold(tree, count)).toBe(8)
  })

  it("hands the node itself to the visitor", () => {
    const names: Visitor<ReadonlyArray<string>> = {
      and: (terms) => terms.flat(),
      or: (terms) => terms.flat(),
      compare: (node) => [node.param],
      missing: (node) => [node.param],
      chain: (next, node) => [node.param, ...next],
      has: (next, node) => [`${node.source}.${node.ref}`, ...next]
    }
    expect(fold(tree, names)).toEqual([
      "code",
      "code",
      "family",
      "patient",
      "Observation.patient",
      "code"
    ])
  })

  it("folds a bare leaf", () => {
    expect(fold(token("x"), count)).toBe(1)
  })
})
