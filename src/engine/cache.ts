import { Effect, Ref } from "effect"
import type { Scoped } from "../compartment/search.js"

export interface Held {
  readonly key: string
  readonly plan: Scoped
}

export interface State {
  readonly enabled: boolean
  readonly keys: ReadonlyArray<string>
  readonly hits: number
  readonly misses: number
  readonly reason: string | undefined
}

export interface Cache {
  readonly take: (key: string) => Effect.Effect<Held | undefined>
  readonly keep: (key: string, plan: Scoped) => Effect.Effect<void>
  readonly demote: (reason: string) => Effect.Effect<void>
  readonly state: Effect.Effect<State>
}

export const CAPACITY = 64

interface Kept {
  readonly enabled: boolean
  readonly entries: ReadonlyMap<string, Held>
  readonly hits: number
  readonly misses: number
  readonly reason: string | undefined
}

const EMPTY: Kept = {
  enabled: true,
  entries: new Map(),
  hits: 0,
  misses: 0,
  reason: undefined
}

const stored = (
  entries: ReadonlyMap<string, Held>,
  key: string,
  plan: Scoped,
  capacity: number
): ReadonlyMap<string, Held> => {
  const next = new Map(entries)
  next.delete(key)
  next.set(key, { key, plan })
  while (next.size > capacity) {
    const oldest = next.keys().next()
    if (oldest.done === true) break
    next.delete(oldest.value)
  }
  return next
}

export const cache = (capacity: number = CAPACITY): Effect.Effect<Cache> =>
  Effect.map(Ref.make(EMPTY), (held) => ({
    take: (key: string) =>
      Ref.modify(held, (kept) => {
        const found = kept.entries.get(key)
        return [
          found,
          found === undefined
            ? { ...kept, misses: kept.misses + 1 }
            : { ...kept, hits: kept.hits + 1 }
        ]
      }),
    keep: (key: string, plan: Scoped) =>
      Ref.update(held, (kept) =>
        kept.enabled
          ? { ...kept, entries: stored(kept.entries, key, plan, capacity) }
          : kept
      ),
    demote: (reason: string) =>
      Ref.update(held, (kept) => ({
        ...kept,
        enabled: false,
        entries: new Map(),
        reason
      })),
    state: Effect.map(Ref.get(held), (kept) => ({
      enabled: kept.enabled,
      keys: [...kept.entries.keys()],
      hits: kept.hits,
      misses: kept.misses,
      reason: kept.reason
    }))
  }))
