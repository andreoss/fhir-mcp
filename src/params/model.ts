import { paramsOf } from "../search/registry.js"
import { parametersOf, types } from "../store/definitions.js"
import type { Param } from "../search/registry.js"
import type { Component, ValueType } from "../search/tree.js"
import type { TypeDefinition } from "../store/definitions.js"

export type Status = "draft" | "backfilling" | "active" | "failed" | "retired"

export interface Definition {
  readonly type: string
  readonly name: string
  readonly valueType: ValueType
  readonly path: ReadonlyArray<string>
  readonly targets: ReadonlyArray<string>
  readonly components: ReadonlyArray<Component>
}

export interface Fault {
  readonly id: string
  readonly reason: string
}

export interface Entry {
  readonly definition: Definition
  readonly status: Status
  readonly version: number
  readonly done: number
  readonly total: number
  readonly failures: number
  readonly updatedAt: string
}

export interface Snapshot {
  readonly epoch: number
  readonly entries: ReadonlyMap<string, Entry>
}

export interface Change {
  readonly type: string
  readonly name: string
  readonly status: Status
  readonly version: number
}

export interface Progress {
  readonly type: string
  readonly name: string
  readonly version: number
  readonly done: number
  readonly total: number
  readonly faults: ReadonlyArray<Fault>
}

export interface Report {
  readonly type: string
  readonly name: string
  readonly status: Status
  readonly version: number
  readonly ready: boolean
  readonly complete: boolean
  readonly done: number
  readonly total: number
  readonly failures: number
  readonly rows: number
}

const NEXT: Record<Status, ReadonlyArray<Status>> = {
  draft: ["backfilling", "retired"],
  backfilling: ["active", "failed", "retired"],
  active: ["backfilling", "retired"],
  failed: ["backfilling", "retired"],
  retired: ["draft"]
}

export const permits = (from: Status, to: Status): boolean => NEXT[from].includes(to)

export const ready = (entry: Entry): boolean => entry.status === "active"

export const complete = (entry: Entry): boolean =>
  entry.done >= entry.total && entry.failures === 0

export const at = (type: string, name: string): string => `${type}.${name}`

export const key = (entry: Entry): string =>
  at(entry.definition.type, entry.definition.name)

export const fold = (
  type: string,
  paths: TypeDefinition,
  shapes: Record<string, Param>
): ReadonlyArray<Definition> =>
  Object.entries(paths).map(([name, held]) => {
    const shape = shapes[name]
    return {
      type,
      name,
      valueType: shape?.valueType ?? "string",
      path: held.path,
      targets: shape?.targets ?? [],
      components: shape?.components ?? []
    }
  })

export const seed = (): ReadonlyArray<Definition> =>
  types().flatMap((type) => fold(type, parametersOf(type) ?? {}, paramsOf(type) ?? {}))
