import { Context, Effect, ParseResult, Schema } from "effect"
import type { FhirResource } from "./engine.js"
import { Conflict, Gone, NotFound, Rejected } from "./outcome.js"
import type { Failure } from "./outcome.js"

export interface Version {
  readonly type: string
  readonly id: string
  readonly versionId: number
  readonly lastUpdated: string
  readonly deleted: boolean
  readonly body: FhirResource
}

export type Criteria = ReadonlyArray<readonly [string, string]>

export interface VersionedStore {
  readonly current: (type: string, id: string) => Effect.Effect<Version | undefined, Failure>
  readonly versionAt: (
    type: string,
    id: string,
    versionId: number
  ) => Effect.Effect<Version | undefined, Failure>
  readonly history: (type: string, id: string) => Effect.Effect<ReadonlyArray<Version>, Failure>
  readonly insertVersion: (entry: Version) => Effect.Effect<void, Failure>
  readonly markDeleted: (
    type: string,
    id: string,
    versionId: number,
    lastUpdated: string
  ) => Effect.Effect<void, Failure>
  readonly purge: (type: string, id: string) => Effect.Effect<void, Failure>
  readonly matching: (
    type: string,
    criteria: Criteria
  ) => Effect.Effect<ReadonlyArray<Version>, Failure>
  readonly mint: (type: string) => Effect.Effect<string, Failure>
  readonly stamp: () => Effect.Effect<string, Failure>
}

export class Versions extends Context.Tag("VersionedStore")<Versions, VersionedStore>() {}

export interface Policy {
  readonly requireVersion: boolean
  readonly skipNoOp: boolean
}

export const defaults: Policy = { requireVersion: false, skipNoOp: true }

export class Rules extends Context.Tag("InteractionPolicy")<Rules, Policy>() {}

export interface Written {
  readonly resource: FhirResource
  readonly versionId: number
  readonly location: string
  readonly etag: string
  readonly created: boolean
  readonly changed: boolean
}

export interface Removed {
  readonly type: string
  readonly id: string
  readonly versionId: number
  readonly mode: "soft" | "hard"
  readonly changed: boolean
}

export interface HistoryQuery {
  readonly since?: string
  readonly at?: string
  readonly before?: string
  readonly count?: number
}

export interface HistoryEntry {
  readonly type: string
  readonly id: string
  readonly versionId: number
  readonly lastUpdated: string
  readonly method: "POST" | "PUT" | "DELETE"
  readonly resource?: FhirResource
}

const JsonOp = Schema.Union(
  Schema.Struct({ op: Schema.Literal("add"), path: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ op: Schema.Literal("replace"), path: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ op: Schema.Literal("remove"), path: Schema.String })
)

const PathOp = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("add"),
    path: Schema.String,
    name: Schema.String,
    value: Schema.Unknown
  }),
  Schema.Struct({ type: Schema.Literal("replace"), path: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("delete"), path: Schema.String })
)

const PatchDoc = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("json"), ops: Schema.Array(JsonOp) }),
  Schema.Struct({ kind: Schema.Literal("fhirpath"), ops: Schema.Array(PathOp) })
)

export type Patch = typeof PatchDoc.Type

const TYPE = /^[A-Z][A-Za-z]{1,63}$/
const ID = /^[A-Za-z0-9\-.]{1,64}$/
const ELEMENT = /^([A-Za-z][A-Za-z0-9]*)(?:\[(\d+)\])?$/

export const etagOf = (versionId: number): string => `W/"${versionId}"`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((problem) =>
      problem.path.length > 0 ? `${problem.path.join(".")}: ${problem.message}` : problem.message
    )
    .join("; ")

const decode = (doc: unknown): Effect.Effect<Patch, Failure> =>
  Schema.decodeUnknown(PatchDoc)(doc, { errors: "all" }).pipe(
    Effect.mapError((error) => new Rejected({ reason: `patch not accepted: ${reasons(error)}` }))
  )

const guard = (type: string, id: string): Effect.Effect<void, Failure> => {
  if (!TYPE.test(type)) {
    return Effect.fail(new Rejected({ reason: `${type} is not a resource type` }))
  }
  if (!ID.test(id)) return Effect.fail(new Rejected({ reason: `${id} is not a resource id` }))
  return Effect.void
}

const shaped = (type: string, body: FhirResource, id: string | undefined) => {
  if (body.resourceType !== type) {
    return Effect.fail(new Rejected({ reason: `body carries ${body.resourceType}, not ${type}` }))
  }
  if (id !== undefined && body.id !== undefined && body.id !== id) {
    return Effect.fail(new Rejected({ reason: `body carries id ${body.id}, not ${id}` }))
  }
  return Effect.void
}

const bare = (body: FhirResource): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === "id" || key === "meta") continue
    out[key] = value
  }
  return out
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

const same = (left: FhirResource, right: FhirResource): boolean =>
  JSON.stringify(canonical(bare(left))) === JSON.stringify(canonical(bare(right)))

const stamped = (
  body: FhirResource,
  id: string,
  versionId: number,
  lastUpdated: string
): FhirResource => {
  const meta = isRecord(body["meta"]) ? body["meta"] : {}
  return { ...body, id, meta: { ...meta, versionId: String(versionId), lastUpdated } }
}

const report = (
  resource: FhirResource,
  type: string,
  id: string,
  versionId: number,
  created: boolean,
  changed: boolean
): Written => ({
  resource,
  versionId,
  location: `${type}/${id}/_history/${versionId}`,
  etag: etagOf(versionId),
  created,
  changed
})

const wanted = (tag: string): number => {
  const trimmed = tag.startsWith("W/") ? tag.slice(2) : tag
  const parsed = Number(trimmed.replace(/"/g, ""))
  return Number.isInteger(parsed) ? parsed : -1
}

const commit = (
  type: string,
  id: string,
  body: FhirResource,
  found: Version | undefined
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const store = yield* Versions
    const policy = yield* Rules
    if (found !== undefined && !found.deleted && policy.skipNoOp && same(body, found.body)) {
      return report(found.body, type, id, found.versionId, false, false)
    }
    const versionId = found === undefined ? 1 : found.versionId + 1
    const lastUpdated = yield* store.stamp()
    const written = stamped(body, id, versionId, lastUpdated)
    yield* store.insertVersion({ type, id, versionId, lastUpdated, deleted: false, body: written })
    return report(written, type, id, versionId, found === undefined || found.deleted, true)
  })

export const read = (type: string, id: string): Effect.Effect<FhirResource, Failure, Versions> =>
  Effect.gen(function* () {
    yield* guard(type, id)
    const store = yield* Versions
    const found = yield* store.current(type, id)
    if (found === undefined) return yield* Effect.fail(new NotFound({ type, id }))
    if (found.deleted) return yield* Effect.fail(new Gone({ type, id }))
    return found.body
  })

export const vread = (
  type: string,
  id: string,
  versionId: string
): Effect.Effect<FhirResource, Failure, Versions> =>
  Effect.gen(function* () {
    yield* guard(type, id)
    const store = yield* Versions
    const asked = Number(versionId)
    if (!Number.isInteger(asked) || asked < 1) {
      return yield* Effect.fail(new NotFound({ type, id }))
    }
    const found = yield* store.versionAt(type, id, asked)
    if (found === undefined) return yield* Effect.fail(new NotFound({ type, id }))
    if (found.deleted) return yield* Effect.fail(new Gone({ type, id }))
    return found.body
  })

export const create = (
  type: string,
  body: FhirResource,
  id?: string
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    yield* shaped(type, body, id)
    const store = yield* Versions
    const chosen = id ?? body.id ?? (yield* store.mint(type))
    yield* guard(type, chosen)
    const found = yield* store.current(type, chosen)
    if (found !== undefined) {
      return yield* Effect.fail(
        new Conflict({ reason: `${type}/${chosen} already has a version` })
      )
    }
    return yield* commit(type, chosen, body, undefined)
  })

export const update = (
  type: string,
  id: string,
  body: FhirResource,
  ifMatch?: string
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    yield* guard(type, id)
    yield* shaped(type, body, id)
    const store = yield* Versions
    const policy = yield* Rules
    const found = yield* store.current(type, id)
    if (found === undefined) {
      if (ifMatch !== undefined) {
        return yield* Effect.fail(
          new Conflict({ reason: `${type}/${id} has no version to match` })
        )
      }
      return yield* commit(type, id, body, undefined)
    }
    if (ifMatch === undefined) {
      if (policy.requireVersion) {
        return yield* Effect.fail(
          new Conflict({ reason: `${type}/${id} requires a version to match` })
        )
      }
    } else if (wanted(ifMatch) !== found.versionId) {
      return yield* Effect.fail(
        new Conflict({ reason: `${type}/${id} is at version ${found.versionId}` })
      )
    }
    return yield* commit(type, id, body, found)
  })

export const remove = (
  type: string,
  id: string,
  mode: "soft" | "hard" = "soft"
): Effect.Effect<Removed, Failure, Versions> =>
  Effect.gen(function* () {
    yield* guard(type, id)
    const store = yield* Versions
    const found = yield* store.current(type, id)
    if (found === undefined) return yield* Effect.fail(new NotFound({ type, id }))
    if (mode === "hard") {
      yield* store.purge(type, id)
      return { type, id, versionId: found.versionId, mode, changed: true }
    }
    if (found.deleted) return { type, id, versionId: found.versionId, mode, changed: false }
    const versionId = found.versionId + 1
    const lastUpdated = yield* store.stamp()
    yield* store.markDeleted(type, id, versionId, lastUpdated)
    return { type, id, versionId, mode, changed: true }
  })

type Mode = "set" | "append" | "replace" | "remove"

interface Step {
  readonly mode: Mode
  readonly path: ReadonlyArray<string>
  readonly value: unknown
}

const pointer = (path: string): ReadonlyArray<string> | undefined => {
  if (!path.startsWith("/")) return undefined
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
}

const elements = (path: string, type: string): ReadonlyArray<string> | undefined => {
  const parts = path.split(".")
  if (parts[0] !== type) return undefined
  const steps: Array<string> = []
  for (const part of parts.slice(1)) {
    const matched = ELEMENT.exec(part)
    const name = matched?.[1]
    if (name === undefined) return undefined
    steps.push(name)
    const index = matched?.[2]
    if (index !== undefined) steps.push(index)
  }
  return steps
}

const plan = (doc: Patch, type: string): ReadonlyArray<Step> | string => {
  const out: Array<Step> = []
  if (doc.kind === "json") {
    for (const op of doc.ops) {
      const path = pointer(op.path)
      if (path === undefined) return `patch path is not a pointer: ${op.path}`
      const mode: Mode = op.op === "add" ? "set" : op.op === "replace" ? "replace" : "remove"
      out.push({ mode, path, value: op.op === "remove" ? undefined : op.value })
    }
    return out
  }
  for (const op of doc.ops) {
    const path = elements(op.path, type)
    if (path === undefined) return `patch path is not an element of ${type}: ${op.path}`
    if (op.type === "add") out.push({ mode: "append", path: [...path, op.name], value: op.value })
    else if (op.type === "replace") out.push({ mode: "replace", path, value: op.value })
    else out.push({ mode: "remove", path, value: undefined })
  }
  return out
}

const at = (node: unknown, step: string): unknown => {
  if (Array.isArray(node)) {
    const index = Number(step)
    return Number.isInteger(index) ? node[index] : undefined
  }
  if (isRecord(node)) return node[step]
  return undefined
}

const onArray = (node: Array<unknown>, token: string, step: Step): string | undefined => {
  if (step.mode === "append") {
    node.push(step.value)
    return undefined
  }
  const index = token === "-" ? node.length : Number(token)
  if (!Number.isInteger(index) || index < 0) return `patch index is not an index: ${token}`
  if (step.mode === "set") {
    if (index > node.length) return `patch index is past the collection: ${token}`
    node.splice(index, 0, step.value)
    return undefined
  }
  if (index >= node.length) return `patch index is past the collection: ${token}`
  if (step.mode === "replace") node[index] = step.value
  else node.splice(index, 1)
  return undefined
}

const onRecord = (node: Record<string, unknown>, key: string, step: Step): string | undefined => {
  if (step.mode === "set") {
    node[key] = step.value
    return undefined
  }
  if (step.mode === "append") {
    const held = node[key]
    if (held === undefined) node[key] = step.value
    else if (Array.isArray(held)) held.push(step.value)
    else return `patch cannot add over the value at ${key}`
    return undefined
  }
  if (!(key in node)) return `patch path is not there: ${key}`
  if (step.mode === "replace") node[key] = step.value
  else delete node[key]
  return undefined
}

const act = (draft: Record<string, unknown>, step: Step): string | undefined => {
  const last = step.path[step.path.length - 1]
  if (last === undefined) return "patch path is empty"
  if (step.path.length === 1 && (last === "id" || last === "resourceType")) {
    return `patch may not change ${last}`
  }
  let node: unknown = draft
  for (const part of step.path.slice(0, -1)) node = at(node, part)
  if (Array.isArray(node)) return onArray(node, last, step)
  if (isRecord(node)) return onRecord(node, last, step)
  return `patch path is not there: ${step.path.join("/")}`
}

export const patch = (
  type: string,
  id: string,
  doc: unknown,
  ifMatch?: string
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    yield* guard(type, id)
    const decoded = yield* decode(doc)
    const store = yield* Versions
    const found = yield* store.current(type, id)
    if (found === undefined) return yield* Effect.fail(new NotFound({ type, id }))
    if (found.deleted) return yield* Effect.fail(new Gone({ type, id }))
    if (ifMatch !== undefined && wanted(ifMatch) !== found.versionId) {
      return yield* Effect.fail(
        new Conflict({ reason: `${type}/${id} is at version ${found.versionId}` })
      )
    }
    const steps = plan(decoded, type)
    if (typeof steps === "string") return yield* Effect.fail(new Rejected({ reason: steps }))
    const draft = structuredClone(found.body) as Record<string, unknown>
    for (const step of steps) {
      const problem = act(draft, step)
      if (problem !== undefined) return yield* Effect.fail(new Rejected({ reason: problem }))
    }
    return yield* commit(type, id, draft as FhirResource, found)
  })

const resolve = (
  type: string,
  criteria: Criteria
): Effect.Effect<Version | undefined, Failure, Versions> =>
  Effect.gen(function* () {
    yield* guard(type, "x")
    if (criteria.length === 0) {
      return yield* Effect.fail(new Rejected({ reason: "conditional interaction needs criteria" }))
    }
    const store = yield* Versions
    const found = yield* store.matching(type, criteria)
    if (found.length > 1) {
      return yield* Effect.fail(
        new Conflict({ reason: `criteria select ${found.length} resources, not one` })
      )
    }
    return found[0]
  })

const named = (criteria: Criteria): string =>
  criteria.map(([name, value]) => `${name}=${value}`).join("&")

export const conditionalCreate = (
  type: string,
  body: FhirResource,
  criteria: Criteria
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const hit = yield* resolve(type, criteria)
    if (hit === undefined) return yield* create(type, body)
    return report(hit.body, type, hit.id, hit.versionId, false, false)
  })

export const conditionalUpdate = (
  type: string,
  body: FhirResource,
  criteria: Criteria,
  ifMatch?: string
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const hit = yield* resolve(type, criteria)
    if (hit === undefined) return yield* create(type, body)
    return yield* update(type, hit.id, body, ifMatch)
  })

export const conditionalRemove = (
  type: string,
  criteria: Criteria,
  mode: "soft" | "hard" = "soft"
): Effect.Effect<Removed, Failure, Versions> =>
  Effect.gen(function* () {
    const hit = yield* resolve(type, criteria)
    if (hit === undefined) return yield* Effect.fail(new NotFound({ type, id: named(criteria) }))
    return yield* remove(type, hit.id, mode)
  })

export const conditionalPatch = (
  type: string,
  criteria: Criteria,
  doc: unknown,
  ifMatch?: string
): Effect.Effect<Written, Failure, Versions | Rules> =>
  Effect.gen(function* () {
    const hit = yield* resolve(type, criteria)
    if (hit === undefined) return yield* Effect.fail(new NotFound({ type, id: named(criteria) }))
    return yield* patch(type, hit.id, doc, ifMatch)
  })

const within = (entry: Version, query: HistoryQuery): boolean => {
  if (query.since !== undefined && entry.lastUpdated < query.since) return false
  if (query.before !== undefined && entry.lastUpdated >= query.before) return false
  if (query.at !== undefined && !entry.lastUpdated.startsWith(query.at)) return false
  return true
}

const entryOf = (entry: Version): HistoryEntry => ({
  type: entry.type,
  id: entry.id,
  versionId: entry.versionId,
  lastUpdated: entry.lastUpdated,
  method: entry.deleted ? "DELETE" : entry.versionId === 1 ? "POST" : "PUT",
  ...(entry.deleted ? {} : { resource: entry.body })
})

export const history = (
  type: string,
  id: string,
  query: HistoryQuery = {}
): Effect.Effect<ReadonlyArray<HistoryEntry>, Failure, Versions> =>
  Effect.gen(function* () {
    yield* guard(type, id)
    if (query.count !== undefined && (!Number.isInteger(query.count) || query.count < 0)) {
      return yield* Effect.fail(new Rejected({ reason: `_count is not a count: ${query.count}` }))
    }
    const store = yield* Versions
    const all = yield* store.history(type, id)
    if (all.length === 0) return yield* Effect.fail(new NotFound({ type, id }))
    const ordered = [...all]
      .sort((a, b) => b.versionId - a.versionId)
      .filter((entry) => within(entry, query))
    const kept = query.count === undefined ? ordered : ordered.slice(0, query.count)
    return kept.map(entryOf)
  })
