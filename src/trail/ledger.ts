import { Effect } from "effect"
import type { Entry, Ledger } from "../agent/audit.js"
import type { Entry as Line } from "./chain.js"
import type { Trail } from "./store.js"

export const addressed = (entry: Entry): string => {
  if (entry.type === undefined) return "other"
  return entry.id === undefined ? entry.type : `${entry.type}/${entry.id}`
}

export const asLine = (entry: Entry): Line => ({
  actor: entry.actor,
  action: entry.interaction,
  resource: addressed(entry),
  outcome: entry.outcome,
  correlation: entry.correlation
})

export const asJournal = (trail: Trail): Ledger => ({
  note: (entry: Entry) => Effect.ignore(trail.append(asLine(entry)))
})
