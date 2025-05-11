import { Effect } from "effect"
import type { Criteria, Version } from "../core/interactions.js"
import { Rejected, Unavailable } from "../core/outcome.js"
import { parametersOf, walk } from "../store/definitions.js"
import type { Schema, SearchState, Writable } from "./incumbent.js"

const SCHEMA: Schema = {
  version: 7,
  table: [
    {
      name: "record",
      column: [
        { name: "type", type: "text" },
        { name: "id", type: "text" },
        { name: "version", type: "integer" },
        { name: "updated", type: "text" },
        { name: "deleted", type: "boolean" },
        { name: "body", type: "json" }
      ]
    },
    {
      name: "record_index",
      column: [
        { name: "type", type: "text" },
        { name: "id", type: "text" },
        { name: "name", type: "text" },
        { name: "value", type: "text" }
      ]
    }
  ]
}

export interface Fake extends Writable {
  readonly all: () => ReadonlyArray<Version>
  readonly log: () => ReadonlyArray<string>
}

const byVersion = (a: Version, b: Version): number => a.versionId - b.versionId

const ordered = (held: ReadonlyArray<Version>): ReadonlyArray<Version> =>
  [...held].sort((a, b) =>
    a.type !== b.type
      ? a.type < b.type
        ? -1
        : 1
      : a.id !== b.id
        ? a.id < b.id
          ? -1
          : 1
        : byVersion(a, b)
  )

export const fake = (
  seed: ReadonlyArray<Version>,
  stale: ReadonlyArray<string> = []
): Fake => {
  const held: Array<Version> = [...seed]
  const written: Array<string> = []

  const kinds = () => [...new Set(held.map((one) => one.type))].sort()

  const latest = (type: string, id: string): Version | undefined =>
    [...held].filter((one) => one.type === type && one.id === id).sort(byVersion).at(-1)

  const schema = () => Effect.succeed(SCHEMA)

  const types = () => Effect.succeed(kinds())

  const records = (type: string) =>
    Effect.succeed(ordered(held.filter((one) => one.type === type)))

  const searchState = () =>
    Effect.succeed(
      kinds().flatMap((type) =>
        Object.keys(parametersOf(type) ?? {}).map(
          (name): SearchState => ({
            type,
            name,
            ready: !stale.includes(name),
            indexed: held.filter((one) => one.type === type && !one.deleted).length
          })
        )
      )
    )

  const read = (type: string, id: string) => Effect.succeed(latest(type, id))

  const matching = (type: string, criteria: Criteria) => {
    const definitions = parametersOf(type)
    if (definitions === undefined) {
      return Effect.fail(new Unavailable({ dependency: "index" }))
    }
    const unknown = criteria
      .map(([name]) => name)
      .filter((name) => definitions[name] === undefined)
    if (unknown.length > 0) {
      return Effect.fail(
        new Rejected({ reason: `unsupported criterion: ${unknown.join(", ")}` })
      )
    }
    const ids = [...new Set(held.filter((one) => one.type === type).map((one) => one.id))]
    const current = ids
      .map((id) => latest(type, id))
      .filter((one): one is Version => one !== undefined && !one.deleted)
    return Effect.succeed(
      ordered(
        current.filter((one) =>
          criteria.every(([name, value]) =>
            walk(one.body, definitions[name]?.path ?? []).includes(value)
          )
        )
      )
    )
  }

  const insert = (entry: Version) =>
    Effect.sync(() => {
      held.push(entry)
      written.push(`insert ${entry.type}/${entry.id}`)
    })

  const drop = (type: string, id: string) =>
    Effect.sync(() => {
      for (let at = held.length - 1; at >= 0; at = at - 1) {
        const one = held[at]
        if (one !== undefined && one.type === type && one.id === id) held.splice(at, 1)
      }
      written.push(`drop ${type}/${id}`)
    })

  return {
    schema,
    types,
    records,
    searchState,
    read,
    matching,
    insert,
    drop,
    all: () => ordered(held),
    log: () => [...written]
  }
}
