import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { DuckDBConnection } from "@duckdb/node-api"
import type { FhirResource } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parametersOf, walk } from "../store/definitions.js"
import { versionedOn } from "../store/versioned.js"
import { ArgsError, Flag, parse } from "./args.js"
import { connect, rows } from "./db.js"
import { guard } from "./guard.js"
import type { Refused } from "./guard.js"
import { readText, writeText } from "./io.js"
import { emit, storePath } from "./result.js"
import type { Outcome } from "./result.js"

export interface ImportOptions {
  readonly replace: boolean
  readonly force: boolean
}

export interface ImportReport {
  readonly action: "import"
  readonly read: number
  readonly written: number
  readonly skipped: number
  readonly problems: ReadonlyArray<string>
}

export interface RebuildReport {
  readonly action: "rebuild"
  readonly resources: number
  readonly entries: number
}

interface Row {
  readonly type: string
  readonly id: string
  readonly body: FhirResource
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rowOf = (text: string, note: (reason: string) => void): Row | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    note("invalid json")
    return undefined
  }
  if (!isRecord(parsed)) {
    note("invalid json: a resource is an object")
    return undefined
  }
  const type = parsed["resourceType"]
  if (typeof type !== "string" || type.length === 0) {
    note("resource carries no resourceType")
    return undefined
  }
  const id = parsed["id"]
  if (typeof id !== "string" || id.length === 0) {
    note("resource carries no id")
    return undefined
  }
  if (parametersOf(type) === undefined) {
    note(`unsupported resource type: ${type}`)
    return undefined
  }
  return { type, id, body: parsed as FhirResource }
}

export const importLines = (
  connection: DuckDBConnection,
  lines: ReadonlyArray<string>,
  options: ImportOptions
): Effect.Effect<ImportReport, Failure | Refused> =>
  Effect.gen(function* () {
    yield* guard(options.replace, options.force, "replace stored resources")
    const store = yield* versionedOn(connection)
    const problems: Array<string> = []
    const purged = new Set<string>()
    let read = 0
    let written = 0
    for (const [at, raw] of lines.entries()) {
      const text = raw.trim()
      if (text.length === 0) continue
      read += 1
      const row = rowOf(text, (reason) => problems.push(`line ${at + 1}: ${reason}`))
      if (row === undefined) continue
      const key = `${row.type}/${row.id}`
      if (options.replace && !purged.has(key)) {
        yield* store.purge(row.type, row.id)
        purged.add(key)
      }
      const existing = yield* store.current(row.type, row.id)
      const lastUpdated = yield* store.stamp()
      yield* store.insertVersion({
        type: row.type,
        id: row.id,
        versionId: (existing?.versionId ?? 0) + 1,
        lastUpdated,
        deleted: false,
        body: row.body
      })
      written += 1
    }
    return { action: "import", read, written, skipped: read - written, problems }
  })

export const exportLines = (
  connection: DuckDBConnection,
  type: string | undefined
): Effect.Effect<ReadonlyArray<string>, Failure> =>
  Effect.gen(function* () {
    if (type !== undefined && parametersOf(type) === undefined) {
      return yield* Effect.fail(new Rejected({ reason: `unsupported resource type: ${type}` }))
    }
    const filter = type === undefined ? "" : " and resource_type = ?"
    const values = type === undefined ? [] : [type]
    const found = yield* rows(
      connection,
      `select body from resource
       where is_current and not deleted${filter}
       order by resource_type, logical_id`,
      values
    )
    return found.map((row) => String(row["body"]))
  })

export const rebuild = (
  connection: DuckDBConnection,
  force: boolean
): Effect.Effect<RebuildReport, Failure | Refused> =>
  Effect.gen(function* () {
    yield* guard(true, force, "rebuild the index")
    yield* rows(connection, "delete from resource_index")
    const found = yield* rows(
      connection,
      `select surrogate_id, resource_type, body from resource
       where not deleted order by surrogate_id`
    )
    let entries = 0
    for (const row of found) {
      const type = String(row["resource_type"])
      const definitions = parametersOf(type)
      if (definitions === undefined) continue
      const body = JSON.parse(String(row["body"])) as FhirResource
      for (const [name, definition] of Object.entries(definitions)) {
        for (const value of walk(body, definition.path)) {
          yield* rows(
            connection,
            `insert into resource_index (surrogate_id, resource_type, name, value)
             values (?, ?, ?, ?)`,
            [row["surrogate_id"], type, name, value]
          )
          entries += 1
        }
      }
    }
    return { action: "rebuild", resources: found.length, entries }
  })

const spec = {
  verbs: ["import", "export", "rebuild"] as ReadonlyArray<string>,
  flags: ["replace", "force"] as ReadonlyArray<string>,
  fields: {
    store: Schema.optional(Schema.String),
    in: Schema.optional(Schema.String),
    out: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    replace: Flag,
    force: Flag
  }
}

export const run = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>
): Effect.Effect<Outcome, ArgsError | Failure | Refused, Scope.Scope> =>
  Effect.gen(function* () {
    const parsed = yield* parse(spec, argv)
    const options = parsed.options
    const source = options.in
    if (parsed.verb === "import" && source === undefined) {
      return yield* Effect.fail(
        new ArgsError({ problems: ["--in: naming the file to import is required"] })
      )
    }
    const connection = yield* connect(storePath(options.store, env))
    if (parsed.verb === "import") {
      const text = yield* readText(source as string)
      const report = yield* importLines(connection, text.split("\n"), {
        replace: options.replace,
        force: options.force
      })
      return emit(report, report.problems.length > 0 ? 1 : 0)
    }
    if (parsed.verb === "export") {
      const lines = yield* exportLines(connection, options.type)
      const out = options.out
      if (out === undefined) return { status: 0, lines }
      yield* writeText(out, lines.length === 0 ? "" : `${lines.join("\n")}\n`)
      return emit({ action: "export", exported: lines.length, out })
    }
    return emit(yield* rebuild(connection, options.force))
  })
