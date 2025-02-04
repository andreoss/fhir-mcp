import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Forbidden, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { FhirResource } from "../core/engine.js"
import { enforce } from "../model/validate.js"

export interface Template {
  readonly id: string
  readonly body: string
}

export interface Approved {
  readonly id: string
  readonly target: string
  readonly digest: string
}

export interface Ask {
  readonly template: string
  readonly input: string
}

interface Rule {
  readonly at: number
  readonly map?: Record<string, string>
}

export const digestOfBody = (body: string): string =>
  createHash("sha256").update(body).digest("hex")

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isRule = (value: unknown): value is Rule =>
  isObject(value) && typeof value["at"] === "number"

const picked = (rule: Rule, parts: ReadonlyArray<string>): unknown => {
  const held = parts[rule.at]
  if (held === undefined || held.length === 0) return undefined
  return rule.map === undefined ? held : rule.map[held] ?? held
}

const render = (node: unknown, parts: ReadonlyArray<string>): unknown => {
  if (typeof node === "string" || typeof node === "boolean") return node
  if (isRule(node)) return picked(node, parts)
  if (Array.isArray(node)) {
    const built = node
      .map((item) => render(item, parts))
      .filter((item) => item !== undefined)
    return built.length === 0 ? undefined : built
  }
  if (!isObject(node)) return undefined
  const built: Record<string, unknown> = {}
  for (const [name, child] of Object.entries(node)) {
    const value = render(child, parts)
    if (value !== undefined) built[name] = value
  }
  return Object.keys(built).length === 0 ? undefined : built
}

const mapping = (id: string, body: string): Effect.Effect<unknown, Failure> =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: () =>
      new Rejected({ reason: `template ${id} carries no mapping` })
  })

const apply = (
  entry: Approved,
  body: string,
  input: string
): Effect.Effect<FhirResource, Failure> =>
  Effect.flatMap(mapping(entry.id, body), (shape) => {
    const built = render(shape, input.split("|"))
    return isObject(built)
      ? Effect.succeed({ resourceType: entry.target, ...built })
      : Effect.fail(
        new Rejected({ reason: `template ${entry.id} built nothing` })
      )
  })

export const convert = (
  approved: ReadonlyArray<Approved>,
  offered: ReadonlyArray<Template>,
  ask: Ask
): Effect.Effect<FhirResource, Failure> =>
  Effect.gen(function* () {
    const plug = offered.find((held) => held.id === ask.template)
    if (plug === undefined) {
      return yield* Effect.fail(
        new Rejected({ reason: `no template is offered as ${ask.template}` })
      )
    }
    const entry = approved.find((held) => held.id === ask.template)
    if (entry === undefined) {
      return yield* Effect.fail(
        new Forbidden({ action: `convert with ${ask.template}, unapproved` })
      )
    }
    if (digestOfBody(plug.body) !== entry.digest) {
      return yield* Effect.fail(
        new Forbidden({ action: `convert with ${ask.template}, altered` })
      )
    }
    const built = yield* apply(entry, plug.body, ask.input)
    yield* enforce(entry.target, built)
    return built
  })
