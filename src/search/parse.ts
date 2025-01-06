import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { controls, isControl } from "./control.js"
import type { Controls } from "./control.js"
import { MODIFIERS, allows, paramsOf } from "./registry.js"
import type { Param } from "./registry.js"
import { every, some } from "./tree.js"
import type { Expr, Modifier, Value } from "./tree.js"
import { parseIdentifier, parseOfType, parseValue, splitOr } from "./value.js"

export interface Query {
  readonly type: string
  readonly expr: Expr | undefined
  readonly controls: Controls
}

const UNSUPPORTED: ReadonlySet<string> = new Set(["_text", "_content", "_filter", "_query"])

const refuse = (reason: string): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason }))

interface Applied {
  readonly modifier: Modifier | undefined
  readonly target: string | undefined
}

const modifierOf = (
  name: string,
  base: string,
  raw: string | undefined,
  param: Param
): Effect.Effect<Applied, Failure> => {
  if (raw === undefined) return Effect.succeed({ modifier: undefined, target: undefined })
  if (param.valueType === "reference" && param.targets.includes(raw)) {
    return Effect.succeed({ modifier: "type" as const, target: raw })
  }
  if (!MODIFIERS.has(raw)) {
    return param.valueType === "reference"
      ? refuse(`${name}: ${base} does not reference ${raw}`)
      : refuse(`${name}: unknown modifier :${raw}`)
  }
  const modifier = raw as Modifier
  return allows(param.valueType, modifier)
    ? Effect.succeed({ modifier, target: undefined })
    : refuse(`${name}: modifier :${modifier} is not valid for a ${param.valueType} parameter`)
}

const valueOf = (
  param: Param,
  modifier: Modifier | undefined,
  raw: string,
  name: string
): Effect.Effect<Value, Failure> => {
  if (modifier === "text") return parseValue("string", raw, name)
  if (modifier === "in" || modifier === "not-in") return parseValue("uri", raw, name)
  if (modifier === "identifier") return parseIdentifier(raw, name)
  if (modifier === "of-type") return parseOfType(raw, name)
  return parseValue(param.valueType, raw, name, param.components)
}

const leaf = (
  type: string,
  params: Record<string, Param>,
  name: string,
  raw: string
): Effect.Effect<Expr, Failure> =>
  Effect.gen(function* () {
    const [base, modifierRaw, ...extra] = name.split(":")
    const head = base ?? name
    if (extra.length > 0) return yield* refuse(`${name}: at most one modifier is accepted`)
    const param = params[head]
    if (param === undefined) {
      return yield* refuse(`unknown search parameter: ${head} on ${type}`)
    }
    const applied = yield* modifierOf(name, head, modifierRaw, param)
    const nodes = yield* Effect.forEach(splitOr(raw), (part) =>
      Effect.gen(function* () {
        if (part.trim().length === 0) {
          return yield* refuse(`empty value not supported: ${name}`)
        }
        if (applied.modifier === "missing") {
          if (part !== "true" && part !== "false") {
            return yield* refuse(`${name}: missing expects true or false, got ${part}`)
          }
          return { kind: "missing", type, param: head, present: part === "false" } as Expr
        }
        const value = yield* valueOf(param, applied.modifier, part, name)
        return {
          kind: "compare",
          type,
          param: head,
          valueType: param.valueType,
          modifier: applied.modifier,
          target: applied.target,
          value
        } as Expr
      })
    )
    const combined = some(nodes)
    return combined === undefined ? yield* refuse(`empty value not supported: ${name}`) : combined
  })

const chained = (
  type: string,
  params: Record<string, Param>,
  head: string,
  rest: string,
  raw: string
): Effect.Effect<Expr, Failure> =>
  Effect.gen(function* () {
    const [base, named, ...extra] = head.split(":")
    if (extra.length > 0) return yield* refuse(`${head}: at most one modifier is accepted`)
    const param = params[base ?? head]
    if (param === undefined) {
      return yield* refuse(`unknown search parameter: ${base} on ${type}`)
    }
    if (param.valueType !== "reference") {
      return yield* refuse(`${head}: ${base} is not a reference and cannot be chained`)
    }
    if (named !== undefined && !param.targets.includes(named)) {
      return yield* refuse(`${head}: ${base} does not reference ${named}`)
    }
    const [only, ...others] = param.targets
    if (named === undefined && (only === undefined || others.length > 0)) {
      return yield* refuse(`${head}: the chain target of ${base} is ambiguous, name the type`)
    }
    const target = named ?? only ?? type
    if (rest.length === 0) {
      return yield* refuse(`${head}.: expected a search parameter after the chain`)
    }
    const next = yield* expression(target, rest, raw)
    return { kind: "chain", type, param: base ?? head, target, next }
  })

const reverse = (type: string, name: string, raw: string): Effect.Effect<Expr, Failure> =>
  Effect.gen(function* () {
    const segments = name.split(":")
    if (segments.length < 4) {
      return yield* refuse(`${name}: expected _has:Type:reference:parameter`)
    }
    const source = segments[1] ?? ""
    const link = segments[2] ?? ""
    const rest = segments.slice(3).join(":")
    const known = paramsOf(source)
    if (known === undefined) {
      return yield* refuse(`${name}: unsupported resource type: ${source}`)
    }
    const param = known[link]
    if (param === undefined) {
      return yield* refuse(`${name}: ${source} declares no search parameter ${link}`)
    }
    if (param.valueType !== "reference") {
      return yield* refuse(`${name}: ${source}.${link} is not a reference`)
    }
    if (!param.targets.includes(type)) {
      return yield* refuse(`${name}: ${source}.${link} does not reference ${type}`)
    }
    const next = yield* expression(source, rest, raw)
    return { kind: "has", type, source, ref: link, next }
  })

const expression = (type: string, name: string, raw: string): Effect.Effect<Expr, Failure> => {
  const params = paramsOf(type)
  if (params === undefined) return refuse(`unsupported resource type: ${type}`)
  if (name === "_has" || name.startsWith("_has:")) return reverse(type, name, raw)
  const dot = name.indexOf(".")
  if (dot >= 0) return chained(type, params, name.slice(0, dot), name.slice(dot + 1), raw)
  return leaf(type, params, name, raw)
}

const headOf = (name: string): string => (name.split(":")[0] ?? name).split(".")[0] ?? name

export const parse = (
  type: string,
  entries: ReadonlyArray<readonly [string, string]>
): Effect.Effect<Query, Failure> =>
  Effect.gen(function* () {
    if (paramsOf(type) === undefined) {
      return yield* refuse(`unsupported resource type: ${type}`)
    }
    const settings: Array<readonly [string, string]> = []
    const terms: Array<Expr> = []
    for (const [name, raw] of entries) {
      const head = headOf(name)
      if (UNSUPPORTED.has(head)) {
        return yield* refuse(`search parameter not supported: ${head}`)
      }
      if (raw.trim().length === 0) {
        return yield* refuse(`empty value not supported: ${name}`)
      }
      if (isControl(head)) settings.push([name, raw])
      else terms.push(yield* expression(type, name, raw))
    }
    return { type, expr: every(terms), controls: yield* controls(type, settings) }
  })
