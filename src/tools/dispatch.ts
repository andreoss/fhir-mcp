import { Effect } from "effect"
import type { Scope } from "effect"
import { run as bench } from "./bench.js"
import { run as data } from "./data.js"
import { run as health } from "./health.js"
import { run as migrate } from "./migrate.js"
import { run as scaffold } from "./scaffold.js"
import { explain } from "./result.js"
import type { Outcome, ToolError } from "./result.js"

export interface Writers {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export const writers: Writers = {
  out: (line) => {
    process.stdout.write(`${line}\n`)
  },
  err: (line) => {
    process.stderr.write(`${line}\n`)
  }
}

type Command = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>
) => Effect.Effect<Outcome, ToolError, Scope.Scope>

const COMMANDS: Record<string, Command> = {
  migrate,
  data,
  bench,
  scaffold,
  health
}

export const USAGE: ReadonlyArray<string> = [
  "usage: tools <command> [options]",
  "  migrate version|next|latest [--store path] [--force]",
  "  data import --in file [--store path] [--replace --force]",
  "  data export [--type name] [--out file] [--store path]",
  "  data rebuild --force [--store path]",
  "  bench generate --out file [--shape name] [--size n] [--seed n]",
  "  bench run [--size n] [--seed n] [--label name] [--store path]",
  "  bench compare --before file --after file [--tolerance ratio]",
  "  scaffold --name job [--dir path] [--force]",
  "  health [--store path]"
]

export const dispatch = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  io: Writers = writers
): Effect.Effect<number> => {
  const name = argv[0]
  if (name === undefined) {
    for (const line of USAGE) io.err(line)
    return Effect.succeed(1)
  }
  if (name === "--help") {
    for (const line of USAGE) io.out(line)
    return Effect.succeed(0)
  }
  const command = COMMANDS[name]
  if (command === undefined) {
    io.err(`unknown command: ${name}`)
    for (const line of USAGE) io.err(line)
    return Effect.succeed(1)
  }
  return Effect.scoped(command(argv.slice(1), env)).pipe(
    Effect.map((outcome) => {
      for (const line of outcome.lines) io.out(line)
      return outcome.status
    }),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        io.err(explain(error))
        return 1
      })
    )
  )
}

export const runTools = (
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  io: Writers = writers
): Promise<number> => Effect.runPromise(dispatch(argv, env, io))
