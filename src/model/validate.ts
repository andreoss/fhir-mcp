import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Issue, OperationOutcome } from "../core/outcome.js"
import { matches, repeats, required } from "./shape.js"
import type { Element, Elements } from "./shape.js"
import { definitionOf } from "./resources.js"

export type Rule =
  | "resource-type"
  | "unknown-resource"
  | "unknown-element"
  | "required"
  | "cardinality"
  | "type"

export interface Problem {
  readonly path: string
  readonly rule: Rule
  readonly detail: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const scanValue = (
  path: string,
  element: Element,
  value: unknown,
  found: Array<Problem>
): void => {
  if (element.kind === "open") return
  if (element.kind === "group") {
    if (!isObject(value)) {
      found.push({ path, rule: "type", detail: "expected an object" })
      return
    }
    scanObject(path, element.children, value, false, found)
    return
  }
  if (!matches(element.kind, value)) {
    found.push({ path, rule: "type", detail: `expected ${element.kind}` })
  }
}

const scanElement = (
  path: string,
  element: Element,
  value: unknown,
  found: Array<Problem>
): void => {
  if (Array.isArray(value)) {
    if (value.length === 0 && required(element.card)) {
      found.push({
        path,
        rule: "required",
        detail: "expected at least one value"
      })
      return
    }
    if (!repeats(element.card)) {
      found.push({
        path,
        rule: "cardinality",
        detail: "expected a single value"
      })
      return
    }
    for (const item of value) scanValue(path, element, item, found)
    return
  }
  if (repeats(element.card)) {
    found.push({ path, rule: "cardinality", detail: "expected an array" })
    return
  }
  scanValue(path, element, value, found)
}

const scanObject = (
  path: string,
  elements: Elements,
  value: Record<string, unknown>,
  root: boolean,
  found: Array<Problem>
): void => {
  for (const [name, element] of Object.entries(elements)) {
    const held = value[name]
    if (held === undefined) {
      if (required(element.card)) {
        found.push({
          path: `${path}.${name}`,
          rule: "required",
          detail: "required element is absent"
        })
      }
      continue
    }
    scanElement(`${path}.${name}`, element, held, found)
  }
  for (const name of Object.keys(value)) {
    if (root && name === "resourceType") continue
    if (elements[name] !== undefined) continue
    if (shadow(name, elements)) continue
    found.push({
      path: `${path}.${name}`,
      rule: "unknown-element",
      detail: "element is not declared"
    })
  }
}

const shadow = (name: string, elements: Elements): boolean =>
  name.startsWith("_") && elements[name.slice(1)] !== undefined

export const render = (problem: Problem): string =>
  `${problem.path}: ${problem.rule}: ${problem.detail}`

const once = (found: ReadonlyArray<Problem>): ReadonlyArray<Problem> => {
  const seen = new Set<string>()
  const kept: Array<Problem> = []
  for (const problem of found) {
    const key = render(problem)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(problem)
  }
  return kept
}

export const check = (
  type: string,
  body: unknown
): ReadonlyArray<Problem> => {
  const declared = isObject(body) ? body["resourceType"] : undefined
  if (declared !== type) {
    const got = typeof declared === "string" ? declared : "no resource type"
    return [{
      path: type,
      rule: "resource-type",
      detail: `expected ${type}, got ${got}`
    }]
  }
  const definition = definitionOf(type)
  if (definition === undefined) {
    return [{
      path: type,
      rule: "unknown-resource",
      detail: "no definition for this type"
    }]
  }
  const found: Array<Problem> = []
  const held = body as Record<string, unknown>
  scanObject(type, definition.elements, held, true, found)
  return once(found)
}

export const outcome = (
  found: ReadonlyArray<Problem>
): OperationOutcome => ({
  resourceType: "OperationOutcome",
  issue: found.map((problem): Issue => ({
    severity: "error",
    code: "invalid",
    diagnostics: render(problem)
  }))
})

export const validate = (
  type: string,
  body: unknown
): Effect.Effect<OperationOutcome> =>
  Effect.sync(() => outcome(check(type, body)))

export const enforce = (
  type: string,
  body: unknown
): Effect.Effect<void, Rejected> =>
  Effect.suspend(() => {
    const found = check(type, body)
    return found.length === 0
      ? Effect.void
      : Effect.fail(
        new Rejected({ reason: found.map(render).join("; ") })
      )
  })
