import { Context } from "effect"
import type { Effect } from "effect"
import type { Version } from "../core/interactions.js"
import type { Failure } from "../core/outcome.js"
import type { Slice } from "./page.js"

export interface Window {
  readonly since?: string
  readonly till?: string
  readonly on?: string
}

export interface Found {
  readonly total: number
  readonly of: ReadonlyArray<Version>
}

export interface Reader {
  readonly get: (type: string, id: string) => Effect.Effect<Version | undefined, Failure>
  readonly compartment: (
    patient: string,
    types: ReadonlyArray<string>,
    window: Window,
    slice: Slice
  ) => Effect.Effect<Found, Failure>
  readonly byIdentifier: (
    type: string,
    value: string
  ) => Effect.Effect<ReadonlyArray<Version>, Failure>
}

export class Records extends Context.Tag("OperationRecords")<Records, Reader>() {}
