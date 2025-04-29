import { Effect, Schema } from "effect"
import { join } from "node:path"
import type { Failure } from "../core/outcome.js"
import { ArgsError, Flag, parse } from "./args.js"
import { guard } from "./guard.js"
import type { Refused } from "./guard.js"
import { exists, listNames, writeText } from "./io.js"
import { emit } from "./result.js"
import type { Outcome } from "./result.js"

export interface Source {
  readonly path: string
  readonly body: string
}

export interface Report {
  readonly action: "scaffold"
  readonly job: string
  readonly dir: string
  readonly written: ReadonlyArray<string>
}

const NAME_RULE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

const camel = (name: string): string =>
  name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())

const moduleBody = (name: string): string => `import { Effect, Schema } from "effect"

export const NAME = "${name}"

export const Input = Schema.Struct({
  target: Schema.String.pipe(Schema.minLength(1)),
  count: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
})

export type Input = typeof Input.Type

export interface Outcome {
  readonly job: string
  readonly done: number
  readonly total: number
}

export const decode = (raw: unknown): Effect.Effect<Input, Error> =>
  Schema.decodeUnknown(Input)(raw, { errors: "all" }).pipe(
    Effect.mapError((error) => new Error(\`\${NAME} refused its input: \${error.message}\`))
  )

export const run = (input: Input): Effect.Effect<Outcome> =>
  Effect.succeed({ job: NAME, done: input.count, total: input.count })
`

const testBody = (name: string): string => `import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { NAME, decode, run } from "./${name}.js"

describe("${name}", () => {
  it("names itself", () => {
    expect(NAME).toBe("${name}")
  })

  it("refuses an input that is not its shape", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(decode({})))).toBe(true)
  })

  it("runs what it decoded", async () => {
    const input = await Effect.runPromise(decode({ target: "Patient", count: 2 }))
    expect(await Effect.runPromise(run(input))).toEqual({ job: NAME, done: 2, total: 2 })
  })
})
`

export const sources = (name: string, dir: string): ReadonlyArray<Source> => [
  { path: join(dir, `${name}.ts`), body: moduleBody(name) },
  { path: join(dir, `${name}.test.ts`), body: testBody(name) }
]

export const registryOf = (names: ReadonlyArray<string>): string => {
  const sorted = [...names].sort()
  const imports = sorted.map((name) => `import * as ${camel(name)} from "./${name}.js"`)
  const entries = sorted.map((name) => `  [${camel(name)}.NAME]: ${camel(name)}`)
  return `${imports.join("\n")}

export const JOBS = {
${entries.join(",\n")}
} as const

export type JobName = keyof typeof JOBS
`
}

export const scaffold = (
  name: string,
  dir: string,
  force: boolean
): Effect.Effect<Report, ArgsError | Failure | Refused> =>
  Effect.gen(function* () {
    if (!NAME_RULE.test(name)) {
      return yield* Effect.fail(
        new ArgsError({
          problems: [
            `--name: a job name is lower case words joined by dashes, got ${JSON.stringify(name)}`
          ]
        })
      )
    }
    const made = sources(name, dir)
    const clashes: Array<string> = []
    for (const file of made) {
      if (yield* exists(file.path)) clashes.push(file.path)
    }
    yield* guard(clashes.length > 0, force, `overwrite ${clashes.join(" and ")}`)
    for (const file of made) {
      yield* writeText(file.path, file.body)
    }
    const present = yield* listNames(dir)
    const jobs = present
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => entry.slice(0, -3))
      .filter((entry) => entry !== "registry")
    const registry = join(dir, "registry.ts")
    yield* writeText(registry, registryOf(jobs))
    return {
      action: "scaffold",
      job: name,
      dir,
      written: [...made.map((file) => file.path), registry]
    }
  })

const spec = {
  flags: ["force"] as ReadonlyArray<string>,
  fields: {
    name: Schema.optional(Schema.String),
    dir: Schema.optionalWith(Schema.String, { default: () => join("src", "jobs") }),
    force: Flag
  }
}

export const run = (
  argv: ReadonlyArray<string>,
  _env: Record<string, string | undefined>
): Effect.Effect<Outcome, ArgsError | Failure | Refused> =>
  Effect.gen(function* () {
    const parsed = yield* parse(spec, argv)
    const name = parsed.options.name
    if (name === undefined) {
      return yield* Effect.fail(
        new ArgsError({ problems: ["--name: naming the job to scaffold is required"] })
      )
    }
    return emit(yield* scaffold(name, parsed.options.dir, parsed.options.force))
  })
