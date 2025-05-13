import { Effect } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { Desk } from "../jobs/service.js"
import { registry } from "../jobs/types.js"
import type { JobState, Registry } from "../jobs/types.js"
import type { Versioned } from "../store/versioned.js"
import type { Depot, Fault, Note, Sheet, Tally } from "./depot.js"
import { deleter } from "./delete.js"
import { exporter } from "./export.js"
import { importer } from "./import.js"
import { reindexer } from "./reindex.js"
import { CONTAINER } from "./spec.js"
import { updater } from "./update.js"

export interface Anonymized {
  readonly location: string
  readonly etag: string
}

export interface Progress {
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly pending: number
}

export interface Account {
  readonly job: string
  readonly kind: string
  readonly state: JobState
  readonly progress: Progress
  readonly detail: string
  readonly output: ReadonlyArray<Sheet>
  readonly error: string | undefined
  readonly rules: Anonymized | undefined
}

export const handlers = (store: Versioned, depot: Depot): Registry =>
  registry({
    export: exporter(store, depot),
    import: importer(store, depot),
    "bulk-delete": deleter(store, depot),
    "bulk-update": updater(store, depot),
    reindex: reindexer(depot)
  })

const told = (fault: Fault): string =>
  fault.line === undefined
    ? fault.reason
    : `${fault.type} line ${fault.line}: ${fault.reason}`

const summed = (marks: ReadonlyArray<Tally>, key: keyof Tally): number =>
  marks.reduce((total, one) => total + Number(one[key]), 0)

const anonymized = (note: Note | undefined): Anonymized | undefined =>
  note === undefined ||
  note.location === undefined ||
  note.etag === undefined
    ? undefined
    : { location: note.location, etag: note.etag }

export const report = (
  counter: Desk,
  depot: Depot,
  job: string
): Effect.Effect<Account, Failure> =>
  Effect.gen(function* () {
    const status = yield* counter.status(job)
    const note = yield* depot.noted(job)
    const marks = yield* depot.marks(job)
    const faults = yield* depot.faults(job)
    const container = note?.container ?? CONTAINER
    const path = `${container}/${job}/error.ndjson`
    if (faults.length > 0) {
      yield* depot.put(
        path,
        faults.map((one) =>
          JSON.stringify(toOutcome(new Rejected({ reason: told(one) })))
        )
      )
    }
    const sheets = yield* depot.list(`${container}/${job}/`)
    const said = note?.detail ?? status.kind
    const counts = [
      `${summed(marks, "written")} written`,
      `${summed(marks, "skipped")} skipped`,
      `${summed(marks, "failed")} failed`
    ].join(", ")
    return {
      job,
      kind: status.kind,
      state: status.state,
      progress: {
        total: status.total,
        done: status.done,
        failed: status.failed,
        pending: status.pending
      },
      detail: `${said}: ${status.done}/${status.total} units, ${counts}`,
      output: sheets.filter((one) => one.path !== path),
      error: faults.length > 0 ? path : undefined,
      rules: anonymized(note)
    }
  })
