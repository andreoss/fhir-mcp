import { Effect } from "effect"
import type { Version } from "../core/interactions.js"
import type { Failure } from "../core/outcome.js"
import type { Incumbent, Schema, SearchState } from "./incumbent.js"

export interface Survey {
  readonly schema: Schema
  readonly type: ReadonlyArray<string>
  readonly record: ReadonlyArray<Version>
  readonly search: ReadonlyArray<SearchState>
}

export interface Tally {
  readonly types: number
  readonly resources: number
  readonly versions: number
  readonly deletes: number
}

const ordered = (record: ReadonlyArray<Version>): ReadonlyArray<Version> =>
  [...record].sort((a, b) =>
    a.type !== b.type
      ? a.type < b.type
        ? -1
        : 1
      : a.id !== b.id
        ? a.id < b.id
          ? -1
          : 1
        : a.versionId - b.versionId
  )

export const survey = (port: Incumbent): Effect.Effect<Survey, Failure> =>
  Effect.gen(function* () {
    const schema = yield* port.schema()
    const type = yield* port.types()
    const gathered = yield* Effect.forEach(type, (one) => port.records(one))
    const search = yield* port.searchState()
    return { schema, type, record: ordered(gathered.flat()), search }
  })

export const tally = (found: Survey): Tally => ({
  types: found.type.length,
  resources: new Set(found.record.map((one) => `${one.type}/${one.id}`)).size,
  versions: found.record.length,
  deletes: found.record.filter((one) => one.deleted).length
})
