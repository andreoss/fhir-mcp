import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { paramsOf } from "./registry.js"

export interface Sort {
  readonly name: string
  readonly descending: boolean
}

export interface Include {
  readonly source: string
  readonly param: string
  readonly target: string | undefined
  readonly iterate: boolean
  readonly wildcard: boolean
}

export type Summary = "true" | "false" | "text" | "data" | "count"

export type Total = "accurate" | "estimate" | "none"

export interface Controls {
  readonly count: number | undefined
  readonly sort: ReadonlyArray<Sort>
  readonly elements: ReadonlyArray<string>
  readonly summary: Summary | undefined
  readonly total: Total | undefined
  readonly include: ReadonlyArray<Include>
  readonly revinclude: ReadonlyArray<Include>
}

const NAMES: ReadonlySet<string> = new Set([
  "_count",
  "_sort",
  "_elements",
  "_summary",
  "_total",
  "_include",
  "_revinclude"
])

const SUMMARY: ReadonlySet<string> = new Set<Summary>(["true", "false", "text", "data", "count"])

const TOTAL: ReadonlySet<string> = new Set<Total>(["accurate", "estimate", "none"])

const WHOLE = /^\d+$/

export const isControl = (name: string): boolean => NAMES.has(name)

const refuse = (reason: string): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason }))

const sorts = (type: string, raw: string): Effect.Effect<ReadonlyArray<Sort>, Failure> => {
  const known = paramsOf(type) ?? {}
  const parsed: Array<Sort> = []
  for (const part of raw.split(",")) {
    const descending = part.startsWith("-")
    const name = descending ? part.slice(1) : part
    if (name.length === 0) return refuse(`_sort: expected a parameter name, got ${raw}`)
    if (known[name] === undefined) {
      return refuse(`_sort: ${type} declares no search parameter ${name}`)
    }
    parsed.push({ name, descending })
  }
  return Effect.succeed(parsed)
}

const elementsOf = (raw: string): Effect.Effect<ReadonlyArray<string>, Failure> => {
  const parts = raw.split(",").map((part) => part.trim())
  return parts.some((part) => part.length === 0)
    ? refuse(`_elements: expected element names, got ${raw}`)
    : Effect.succeed(parts)
}

const iterating = (name: string, modifier: string | undefined): Effect.Effect<boolean, Failure> => {
  if (modifier === undefined) return Effect.succeed(false)
  if (modifier === "iterate" || modifier === "recurse") return Effect.succeed(true)
  return refuse(`${name}: unknown modifier :${modifier}`)
}

const included = (
  name: string,
  raw: string,
  iterate: boolean
): Effect.Effect<Include, Failure> => {
  if (raw === "*") {
    return Effect.succeed({ source: "*", param: "*", target: undefined, iterate, wildcard: true })
  }
  const parts = raw.split(":")
  if (parts.length < 2 || parts.length > 3) {
    return refuse(`${name}: expected type:parameter[:type], got ${raw}`)
  }
  const [source, param, target] = parts
  const known = paramsOf(source ?? "")
  if (known === undefined) return refuse(`${name}: unsupported resource type: ${source}`)
  if (param === "*") {
    return Effect.succeed({
      source: source ?? "",
      param: "*",
      target: target,
      iterate,
      wildcard: true
    })
  }
  const found = known[param ?? ""]
  if (found === undefined) {
    return refuse(`${name}: ${source} declares no search parameter ${param}`)
  }
  if (found.valueType !== "reference") {
    return refuse(`${name}: ${source}.${param} is not a reference`)
  }
  if (target !== undefined && !found.targets.includes(target)) {
    return refuse(`${name}: ${source}.${param} does not reference ${target}`)
  }
  return Effect.succeed({
    source: source ?? "",
    param: param ?? "",
    target,
    iterate,
    wildcard: false
  })
}

export const controls = (
  type: string,
  entries: ReadonlyArray<readonly [string, string]>
): Effect.Effect<Controls, Failure> =>
  Effect.gen(function* () {
    let count: number | undefined = undefined
    let sort: ReadonlyArray<Sort> = []
    let elements: ReadonlyArray<string> = []
    let summary: Summary | undefined = undefined
    let total: Total | undefined = undefined
    const include: Array<Include> = []
    const revinclude: Array<Include> = []
    for (const [name, raw] of entries) {
      const [base, modifier, ...extra] = name.split(":")
      if (extra.length > 0) return yield* refuse(`${base}: at most one modifier is accepted`)
      if (base === "_include" || base === "_revinclude") {
        const iterate = yield* iterating(base, modifier)
        const one = yield* included(base, raw, iterate)
        if (base === "_include") include.push(one)
        else revinclude.push(one)
        continue
      }
      if (modifier !== undefined) return yield* refuse(`${base}: takes no modifier`)
      if (base === "_count") {
        if (!WHOLE.test(raw)) return yield* refuse(`_count: expected a whole number, got ${raw}`)
        count = Number(raw)
      } else if (base === "_sort") {
        sort = yield* sorts(type, raw)
      } else if (base === "_elements") {
        elements = yield* elementsOf(raw)
      } else if (base === "_summary") {
        if (!SUMMARY.has(raw)) return yield* refuse(`_summary: unsupported value ${raw}`)
        summary = raw as Summary
      } else if (base === "_total") {
        if (!TOTAL.has(raw)) return yield* refuse(`_total: unsupported value ${raw}`)
        total = raw as Total
      }
    }
    return { count, sort, elements, summary, total, include, revinclude }
  })
