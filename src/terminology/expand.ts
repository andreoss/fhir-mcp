import { Effect } from "effect"
import { NotFound, Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { ancestorOf, asOf, byCode, resolve } from "./system.js"
import type { CodeSystem, Concept, Include, Sources } from "./system.js"
import type { Contains, ExpandRequest, Expansion, Parameter } from "./port.js"

interface Picked {
  readonly system: CodeSystem
  readonly concept: Concept
}

interface Node {
  readonly picked: Picked
  readonly children: Array<Node>
}

const key = (picked: Picked): string => `${picked.system.url}|${picked.concept.code}`

const displayOf = (concept: Concept, language: string | undefined): string | undefined => {
  if (language !== undefined) {
    const named = (concept.designation ?? []).find((item) => item.language === language)
    if (named !== undefined) return named.value
  }
  return concept.display
}

const checkPins = (request: ExpandRequest): Effect.Effect<void, Failure> =>
  Effect.forEach(request.versions ?? [], (pin) =>
    pin.includes("|")
      ? Effect.void
      : Effect.fail(new Rejected({ reason: `versions expects system|version, got ${pin}` }))
  ).pipe(Effect.asVoid)

const whole = (name: string, value: number | undefined): Effect.Effect<void, Failure> =>
  value === undefined || (Number.isInteger(value) && value >= 0)
    ? Effect.void
    : Effect.fail(new Rejected({ reason: `${name} expects a whole number, got ${value}` }))

const checkPaging = (request: ExpandRequest): Effect.Effect<void, Failure> =>
  Effect.zipRight(whole("count", request.count), whole("offset", request.offset))

const versionFor = (request: ExpandRequest, include: Include): string | undefined => {
  for (const pin of request.versions ?? []) {
    const at = pin.indexOf("|")
    if (pin.slice(0, at) === include.system) return pin.slice(at + 1)
  }
  return include.version
}

const systemFor = (
  all: Sources,
  dated: Sources,
  request: ExpandRequest,
  include: Include
): Effect.Effect<CodeSystem, Failure> => {
  const version = versionFor(request, include)
  const found = resolve(dated, include.system, version)
  if (found._tag === "System") return Effect.succeed(found.system)
  if (found._tag === "Unsupplied") {
    return Effect.fail(
      new Rejected({
        reason: `${include.system} carries no content here: ${found.record.reason}`
      })
    )
  }
  if (request.date !== undefined && resolve(all, include.system, version)._tag === "System") {
    return Effect.fail(
      new Rejected({ reason: `no content for ${include.system} at ${request.date}` })
    )
  }
  return Effect.fail(new Rejected({ reason: `unknown code system: ${include.system}` }))
}

const selected = (
  system: CodeSystem,
  include: Include
): Effect.Effect<ReadonlyArray<Concept>, Failure> => {
  const named = include.concept
  if (named !== undefined) {
    const index = byCode(system)
    return Effect.forEach(named, (item) => {
      const concept = index.get(item.code)
      return concept === undefined
        ? Effect.fail(new Rejected({ reason: `${item.code} is not in ${system.url}` }))
        : Effect.succeed(concept)
    })
  }
  return Effect.reduce(
    include.filter ?? [],
    system.concept,
    (kept: ReadonlyArray<Concept>, filter) => {
      if (filter.op === "is-a") {
        return Effect.succeed(
          kept.filter(
            (concept) =>
              concept.code === filter.value || ancestorOf(system, filter.value, concept.code)
          )
        )
      }
      if (filter.op === "descendent-of") {
        return Effect.succeed(
          kept.filter((concept) => ancestorOf(system, filter.value, concept.code))
        )
      }
      return Effect.fail(
        new Rejected({ reason: `unsupported filter: ${filter.property} ${filter.op}` })
      )
    }
  )
}

const gather = (
  all: Sources,
  dated: Sources,
  request: ExpandRequest,
  includes: ReadonlyArray<Include>
): Effect.Effect<ReadonlyArray<Picked>, Failure> =>
  Effect.map(
    Effect.forEach(includes, (include) =>
      Effect.flatMap(systemFor(all, dated, request, include), (system) =>
        Effect.map(selected(system, include), (concepts) =>
          concepts.map((concept) => ({ system, concept }))
        )
      )
    ),
    (lists) => lists.flat()
  )

const entry = (
  picked: Picked,
  request: ExpandRequest,
  children: ReadonlyArray<Contains> | undefined
): Contains => ({
  system: picked.system.url,
  version: picked.system.version,
  code: picked.concept.code,
  display: displayOf(picked.concept, request.displayLanguage),
  inactive: picked.concept.inactive === true ? true : undefined,
  designation: request.designations === true ? picked.concept.designation ?? [] : undefined,
  contains: children
})

const nest = (picked: ReadonlyArray<Picked>): ReadonlyArray<Node> => {
  const nodes = new Map<string, Node>()
  const roots: Array<Node> = []
  for (const item of picked) nodes.set(key(item), { picked: item, children: [] })
  for (const item of picked) {
    const node = nodes.get(key(item))
    if (node === undefined) continue
    const parent = item.concept.parent
    const above = parent === undefined ? undefined : nodes.get(`${item.system.url}|${parent}`)
    if (above === undefined) roots.push(node)
    else above.children.push(node)
  }
  return roots
}

const rendered = (nodes: ReadonlyArray<Node>, request: ExpandRequest): ReadonlyArray<Contains> =>
  nodes.map((node) =>
    entry(
      node.picked,
      request,
      node.children.length === 0 ? undefined : rendered(node.children, request)
    )
  )

const parameters = (request: ExpandRequest, flat: boolean): ReadonlyArray<Parameter> => {
  const out: Array<Parameter> = []
  if (request.filter !== undefined) out.push({ name: "filter", value: request.filter })
  if (request.count !== undefined) out.push({ name: "count", value: request.count })
  if (request.offset !== undefined) out.push({ name: "offset", value: request.offset })
  if (request.date !== undefined) out.push({ name: "date", value: request.date })
  if (request.activeOnly !== undefined) out.push({ name: "activeOnly", value: request.activeOnly })
  if (request.displayLanguage !== undefined) {
    out.push({ name: "displayLanguage", value: request.displayLanguage })
  }
  if (request.designations !== undefined) {
    out.push({ name: "includeDesignations", value: request.designations })
  }
  out.push({ name: "excludeNested", value: flat })
  for (const pin of request.versions ?? []) out.push({ name: "system-version", value: pin })
  return out
}

const matching = (picked: ReadonlyArray<Picked>, request: ExpandRequest) => {
  const text = request.filter
  if (text === undefined || text.length === 0) return picked
  const needle = text.toLowerCase()
  return picked.filter((item) => {
    const display = displayOf(item.concept, request.displayLanguage)
    return (
      item.concept.code.toLowerCase().includes(needle) ||
      (display !== undefined && display.toLowerCase().includes(needle))
    )
  })
}

export const expand = (
  sources: Sources,
  request: ExpandRequest,
  timestamp: string
): Effect.Effect<Expansion, Failure> =>
  Effect.gen(function* () {
    yield* checkPins(request)
    yield* checkPaging(request)
    const valueSet = (sources.valueSets ?? []).find((held) => held.url === request.url)
    if (valueSet === undefined) {
      return yield* Effect.fail(new NotFound({ type: "ValueSet", id: request.url }))
    }
    const dated = request.date === undefined ? sources : asOf(sources, request.date)
    const included = yield* gather(sources, dated, request, valueSet.include)
    const removed = yield* gather(sources, dated, request, valueSet.exclude ?? [])
    const dropped = new Set(removed.map(key))
    const active = included.filter(
      (item) =>
        !dropped.has(key(item)) &&
        (request.activeOnly !== true || item.concept.inactive !== true)
    )
    const kept = matching(active, request)
    const paging = request.count !== undefined || request.offset !== undefined
    const offset = request.offset ?? 0
    const page = paging
      ? kept.slice(offset, request.count === undefined ? undefined : offset + request.count)
      : kept
    const flat = paging || request.excludeNested === true
    return {
      resourceType: "ValueSet",
      url: valueSet.url,
      version: valueSet.version,
      expansion: {
        timestamp,
        total: kept.length,
        offset: paging ? offset : undefined,
        parameter: parameters(request, flat),
        contains: flat
          ? page.map((item) => entry(item, request, undefined))
          : rendered(nest(page), request)
      }
    }
  })
