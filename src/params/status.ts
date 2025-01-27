import { Effect } from "effect"
import { NotFound } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { at, complete, ready } from "./model.js"
import type { Change, Progress, Report } from "./model.js"
import type { Registry, View } from "./registry.js"

const reported = (
  found: View,
  type: string,
  name: string
): Effect.Effect<Report, Failure> => {
  const entry = found.entry
  if (entry === undefined) {
    return Effect.fail(new NotFound({ type: "SearchParameter", id: at(type, name) }))
  }
  return Effect.succeed({
    type,
    name,
    status: entry.status,
    version: entry.version,
    ready: ready(entry),
    complete: complete(entry),
    done: entry.done,
    total: entry.total,
    failures: entry.failures,
    rows: found.rows
  })
}

export const query = (
  registry: Registry,
  type: string,
  name: string
): Effect.Effect<Report, Failure> =>
  registry.view(type, name).pipe(Effect.flatMap((found) => reported(found, type, name)))

export const post = (
  registry: Registry,
  change: Change
): Effect.Effect<Report, Failure> =>
  registry.advance(change).pipe(Effect.zipRight(query(registry, change.type, change.name)))

export const update = (
  registry: Registry,
  progress: Progress
): Effect.Effect<Report, Failure> =>
  registry
    .record(progress)
    .pipe(Effect.zipRight(query(registry, progress.type, progress.name)))
