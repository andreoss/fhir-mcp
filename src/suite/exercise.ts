import { paramType } from "../conformance/capability.js"
import type { ParamType } from "../conformance/capability.js"
import type { Registry } from "../conformance/versions.js"
import { definitionOf } from "../model/resources.js"
import { repeats, required } from "../model/shape.js"
import type { Element, Elements } from "../model/shape.js"
import { surface } from "../protocol/server.js"
import { walk } from "../store/definitions.js"
import type { Called } from "./harness.js"

export interface Concept {
  readonly system: string
  readonly code: string
  readonly display: string
}

export interface Carried {
  readonly write: boolean
  readonly terms?: Concept
  readonly jobs?: boolean
}

export interface Keep {
  readonly name: string
  readonly at: ReadonlyArray<string>
}

export type Want =
  | { readonly kind: "types"; readonly types: ReadonlyArray<string> }
  | {
    readonly kind: "parameters"
    readonly type: string
    readonly parameters: ReadonlyArray<string>
  }
  | {
    readonly kind: "record"
    readonly type: string
    readonly id: string
    readonly version: string
  }
  | { readonly kind: "bundle"; readonly type: string; readonly total: number }
  | { readonly kind: "removed" }
  | { readonly kind: "absent"; readonly code: string }
  | { readonly kind: "concept"; readonly concept: Concept }
  | { readonly kind: "ticket"; readonly base: string }
  | { readonly kind: "state"; readonly state: string }

export interface Step {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly want: Want
  readonly keep?: Keep
  readonly settle?: number
}

export type Call = (name: string, args: unknown) => Promise<Called>

const JOB = "job"

const ID = "${job}"

const KIND = "reindex"

const REQUEST = "{}"

const JOBS = "/jobs"

const DONE = "done"

const CONFLICT = "conflict"

const TRIES = 40

const POLL = 100

const SAMPLES: Readonly<Record<ParamType, string>> = {
  number: "1",
  date: "2024-01-01",
  string: "text",
  token: "v",
  reference: "Patient/one",
  composite: "v",
  quantity: "1",
  uri: "http://example.test/v",
  special: "v"
}

export const sample = (type: ParamType): string => SAMPLES[type]

const PRIMITIVES: Readonly<Record<string, unknown>> = {
  string: "text",
  boolean: true,
  integer: 1,
  decimal: 1,
  date: "2024-01-01",
  dateTime: "2024-01-01T00:00:00Z",
  instant: "2024-01-01T00:00:00Z",
  uri: "http://example.test/v",
  code: "v",
  id: "v"
}

const built = (element: Element): unknown => {
  if (element.kind === "open") return repeats(element.card) ? [] : {}
  if (element.kind === "group") {
    const held = filled(element.children)
    return repeats(element.card) ? [held] : held
  }
  const value = PRIMITIVES[element.kind]
  return repeats(element.card) ? [value] : value
}

const filled = (elements: Elements): Record<string, unknown> => {
  const held: Record<string, unknown> = {}
  for (const [name, element] of Object.entries(elements)) {
    if (!required(element.card)) continue
    held[name] = built(element)
  }
  return held
}

export const bodyOf = (type: string): Record<string, unknown> => {
  const definition = definitionOf(type)
  return {
    resourceType: type,
    ...(definition === undefined ? {} : filled(definition.elements))
  }
}

export const stepsOf = (registry: Registry, carried: Carried): ReadonlyArray<Step> => {
  const served = new Set(
    surface(carried.write, carried.terms !== undefined, carried.jobs === true).map(
      (tool) => tool.name
    )
  )
  const steps: Array<Step> = []
  const ask = (
    tool: string,
    args: Record<string, unknown>,
    want: Want,
    keep?: Keep,
    settle?: number
  ): void => {
    if (!served.has(tool)) return
    steps.push({
      tool,
      args,
      want,
      ...(keep === undefined ? {} : { keep }),
      ...(settle === undefined ? {} : { settle })
    })
  }
  const types = registry.types()
  ask("capabilities", {}, { kind: "types", types })
  for (const type of types) {
    const declared = registry.parametersOf(type) ?? {}
    const entries = Object.entries(declared).sort(([left], [right]) =>
      left.localeCompare(right)
    )
    const id = `agt-9-${type.toLowerCase()}`
    const made = { ...bodyOf(type), id }
    ask("capabilities", { type }, {
      kind: "parameters",
      type,
      parameters: entries.map(([name]) => name)
    })
    if (carried.write) {
      ask("create", { type, id, body: made }, { kind: "record", type, id, version: "1" })
      ask("read", { type, id }, { kind: "record", type, id, version: "1" })
    } else {
      ask("read", { type, id }, { kind: "absent", code: "not-found" })
    }
    for (const [name, definition] of entries) {
      const value = name === "_id" ? id : sample(paramType(definition.path))
      const held = carried.write && walk(made, definition.path).includes(value)
      ask("search", { type, parameters: { [name]: value } }, {
        kind: "bundle",
        type,
        total: held ? 1 : 0
      })
    }
    if (carried.write) {
      const body = { ...made, language: "en" }
      ask("update", { type, id, body }, { kind: "record", type, id, version: "2" })
      ask(
        "patch",
        {
          type,
          id,
          patch: { kind: "json", ops: [{ op: "replace", path: "/language", value: "fr" }] }
        },
        { kind: "record", type, id, version: "3" }
      )
      ask("delete", { type, id }, { kind: "removed" })
      ask("read", { type, id }, { kind: "absent", code: "deleted" })
    }
  }
  if (carried.terms !== undefined) {
    const terms = carried.terms
    ask("lookup", { system: terms.system, code: terms.code }, {
      kind: "concept",
      concept: terms
    })
  }
  if (carried.jobs === true) {
    ask("job-submit", { kind: KIND, request: REQUEST }, { kind: "ticket", base: JOBS }, {
      name: JOB,
      at: ["id"]
    })
    ask("job-status", { id: ID }, { kind: "state", state: DONE }, undefined, TRIES)
    ask("job-output", { id: ID }, { kind: "state", state: DONE })
    ask("job-cancel", { id: ID }, { kind: "absent", code: CONFLICT })
  }
  return steps
}

const held = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((one): one is string => typeof one === "string")
    : []

const named = (field: string, wanted: unknown, got: unknown): ReadonlyArray<string> =>
  wanted === got
    ? []
    : [`${field}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`]

const alike = (
  field: string,
  wanted: ReadonlyArray<string>,
  got: ReadonlyArray<string>
): ReadonlyArray<string> =>
  [...wanted].sort().join(",") === [...got].sort().join(",")
    ? []
    : [`${field}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`]

export const faults = (want: Want, body: unknown): ReadonlyArray<string> => {
  const found = held(body)
  switch (want.kind) {
    case "types":
      return alike("resourceTypes", want.types, stringsOf(found["resourceTypes"]))
    case "parameters":
      return [
        ...named("type", want.type, found["type"]),
        ...alike("parameters", want.parameters, stringsOf(found["parameters"]))
      ]
    case "record":
      return [
        ...named("resourceType", want.type, found["resourceType"]),
        ...named("id", want.id, found["id"]),
        ...named("meta.versionId", want.version, held(found["meta"])["versionId"])
      ]
    case "bundle":
      return [
        ...named("resourceType", "Bundle", found["resourceType"]),
        ...named("type", "searchset", found["type"]),
        ...named("total", want.total, found["total"])
      ]
    case "removed":
      return [
        ...named("mode", "soft", found["mode"]),
        ...named("changed", true, found["changed"])
      ]
    case "absent":
      return [
        ...named("resourceType", "OperationOutcome", found["resourceType"]),
        ...named(
          "issue.code",
          want.code,
          held((found["issue"] as ReadonlyArray<unknown> | undefined)?.[0])["code"]
        )
      ]
    case "concept":
      return [
        ...named("_tag", "Found", found["_tag"]),
        ...named("system", want.concept.system, found["system"]),
        ...named("code", want.concept.code, found["code"]),
        ...named("display", want.concept.display, found["display"])
      ]
    case "ticket": {
      const id = found["id"]
      return [
        ...(typeof id === "string" && id.length > 0
          ? []
          : [`id: expected a job id, got ${JSON.stringify(id)}`]),
        ...named("location", `${want.base}/${String(id)}`, found["location"]),
        ...(typeof found["retryAfter"] === "number" && found["retryAfter"] > 0
          ? []
          : [
            `retryAfter: expected a positive number, got ${JSON.stringify(
              found["retryAfter"]
            )}`
          ])
      ]
    }
    case "state":
      return named("state", want.state, found["state"])
  }
}

export const taken = (
  body: unknown,
  at: ReadonlyArray<string>
): string | undefined => {
  let found: unknown = body
  for (const field of at) found = held(found)[field]
  return found === undefined || found === null ? undefined : String(found)
}

const substituted = (
  args: Record<string, unknown>,
  kept: Readonly<Record<string, string>>
): Record<string, unknown> => {
  const asked: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(args)) {
    asked[field] =
      typeof value === "string"
        ? value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => kept[name] ?? whole)
        : value
  }
  return asked
}

const later = (ms: number): Promise<void> =>
  new Promise((settled) => setTimeout(settled, ms))

export const drive = async (
  steps: ReadonlyArray<Step>,
  call: Call,
  pause: number = POLL
): Promise<ReadonlyArray<string>> => {
  const kept: Record<string, string> = {}
  const reports: Array<string> = []
  for (const step of steps) {
    const args = substituted(step.args, kept)
    const tries = step.settle ?? 1
    let body: unknown = undefined
    let bad: ReadonlyArray<string> = []
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      const called = await call(step.tool, args)
      if (called.kind !== "answered") throw new Error(`${step.tool} was refused`)
      body = called.body
      bad = [
        ...(called.isError === (step.want.kind === "absent")
          ? []
          : [
            `isError: expected ${String(step.want.kind === "absent")}, got ${String(
              called.isError
            )}`
          ]),
        ...faults(step.want, called.body)
      ]
      if (bad.length === 0) break
      if (attempt < tries) await later(pause)
    }
    for (const fault of bad) reports.push(`${step.tool}: ${fault}`)
    if (step.keep !== undefined) {
      const found = taken(body, step.keep.at)
      if (found !== undefined) kept[step.keep.name] = found
    }
  }
  return reports
}
