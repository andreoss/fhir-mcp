import { Effect } from "effect"
import type { Criteria, Version } from "../core/interactions.js"
import { Forbidden } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Column {
  readonly name: string
  readonly type: string
}

export interface Table {
  readonly name: string
  readonly column: ReadonlyArray<Column>
}

export interface Schema {
  readonly version: number
  readonly table: ReadonlyArray<Table>
}

export interface SearchState {
  readonly type: string
  readonly name: string
  readonly ready: boolean
  readonly indexed: number
}

export interface Reader {
  readonly read: (type: string, id: string) => Effect.Effect<Version | undefined, Failure>
  readonly matching: (
    type: string,
    criteria: Criteria
  ) => Effect.Effect<ReadonlyArray<Version>, Failure>
}

export interface Incumbent extends Reader {
  readonly schema: () => Effect.Effect<Schema, Failure>
  readonly types: () => Effect.Effect<ReadonlyArray<string>, Failure>
  readonly records: (type: string) => Effect.Effect<ReadonlyArray<Version>, Failure>
  readonly searchState: () => Effect.Effect<ReadonlyArray<SearchState>, Failure>
}

export interface Writable extends Incumbent {
  readonly insert: (entry: Version) => Effect.Effect<void, Failure>
  readonly drop: (type: string, id: string) => Effect.Effect<void, Failure>
}

export const READS: ReadonlyArray<string> = [
  "schema",
  "types",
  "records",
  "searchState",
  "read",
  "matching"
]

const allowed = new Set(READS)

const opaque = new Set(["then", "catch", "finally"])

const settled = <A>(value: A): A => {
  if (Array.isArray(value)) {
    for (const item of value) settled(item)
    return Object.freeze(value)
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) settled(item)
    return Object.freeze(value)
  }
  return value
}

const refuse = (name: string) => () =>
  Effect.fail(new Forbidden({ action: `incumbent.${name}` }))

export const sealed = (source: Incumbent): Incumbent =>
  new Proxy({} as Incumbent, {
    get: (_target, key) => {
      if (typeof key === "symbol") return undefined
      if (opaque.has(key)) return undefined
      if (!allowed.has(key)) return refuse(key)
      const held: unknown = Reflect.get(source, key)
      if (typeof held !== "function") return refuse(key)
      return (...args: ReadonlyArray<unknown>) =>
        Effect.map(
          Reflect.apply(held, source, args) as Effect.Effect<unknown, Failure>,
          settled
        )
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    has: (_target, key) => typeof key === "string" && allowed.has(key),
    ownKeys: () => [...allowed],
    getOwnPropertyDescriptor: () => ({
      configurable: true,
      enumerable: true,
      value: undefined
    })
  })
