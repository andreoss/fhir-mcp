import { Data, Effect, ParseResult, Schema } from "effect"

export class ArgsError extends Data.TaggedError("ArgsError")<{
  readonly problems: ReadonlyArray<string>
}> {
  override get message(): string {
    return `arguments rejected:\n  ${this.problems.join("\n  ")}`
  }
}

export const oneOf = <A extends string>(...values: ReadonlyArray<A>) =>
  Schema.Literal(...values).annotations({
    message: (issue) =>
      `expected one of ${values.map((v) => `"${v}"`).join(", ")}, got ${JSON.stringify(issue.actual)}`
  })

const digits = (accept: (raw: string) => boolean, wanted: string) =>
  Schema.transform(
    Schema.String.pipe(Schema.filter(accept)).annotations({
      message: (issue) => `expected ${wanted}, got ${JSON.stringify(issue.actual)}`
    }),
    Schema.Number,
    { strict: true, decode: (raw) => Number(raw), encode: (value) => String(value) }
  )

export const Count = digits(
  (raw) => /^[0-9]+$/.test(raw) && Number(raw) > 0,
  "a positive whole number"
)

export const Whole = digits((raw) => /^[0-9]+$/.test(raw), "a whole number")

export const Ratio = digits(
  (raw) => /^[0-9]+(\.[0-9]+)?$/.test(raw) && Number(raw) <= 1,
  "a ratio between 0 and 1"
)

export const Flag = Schema.optionalWith(
  Schema.transform(oneOf("true", "false"), Schema.Boolean, {
    strict: true,
    decode: (raw) => raw === "true",
    encode: (on) => (on ? "true" : "false")
  }),
  { default: () => false }
)

export interface Spec<F extends Schema.Struct.Fields> {
  readonly verbs?: ReadonlyArray<string>
  readonly flags: ReadonlyArray<string>
  readonly fields: F
}

export interface Parsed<F extends Schema.Struct.Fields> {
  readonly verb: string
  readonly options: Schema.Schema.Type<Schema.Struct<F>>
}

const dashed = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const describe = (error: ParseResult.ParseError): ReadonlyArray<string> => {
  const byKey = new Map<string, Set<string>>()
  for (const issue of ParseResult.ArrayFormatter.formatErrorSync(error)) {
    const key = issue.path.length > 0 ? `--${dashed(String(issue.path[0]))}` : "arguments"
    const seen = byKey.get(key) ?? new Set<string>()
    seen.add(issue.message)
    byKey.set(key, seen)
  }
  return [...byKey].map(([key, messages]) => `${key}: ${[...messages].join("; ")}`)
}

const verbOf = (
  verbs: ReadonlyArray<string>,
  tokens: Array<string>,
  problems: Array<string>
): string => {
  const listed = verbs.map((verb) => `"${verb}"`).join(", ")
  const head = tokens[0]
  if (head === undefined || head.startsWith("--")) {
    problems.push(`expected one of ${listed}, got nothing`)
    return ""
  }
  tokens.shift()
  if (verbs.includes(head)) return head
  problems.push(`expected one of ${listed}, got ${JSON.stringify(head)}`)
  return ""
}

export const parse = <F extends Schema.Struct.Fields>(
  spec: Spec<F>,
  argv: ReadonlyArray<string>
): Effect.Effect<Parsed<F>, ArgsError, Schema.Schema.Context<Schema.Struct<F>>> => {
  const names = new Map(Object.keys(spec.fields).map((key) => [dashed(key), key]))
  const toggles = new Set(spec.flags.map((flag) => dashed(flag)))
  const known = [...names.keys()].map((name) => `--${name}`).join(", ")
  const problems: Array<string> = []
  const raw: Record<string, string> = {}
  const tokens = [...argv]
  const verb = spec.verbs === undefined ? "" : verbOf(spec.verbs, tokens, problems)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] as string
    index += 1
    if (!token.startsWith("--")) {
      problems.push(`unexpected argument: ${token}`)
      continue
    }
    const body = token.slice(2)
    const split = body.indexOf("=")
    const flag = split === -1 ? body : body.slice(0, split)
    let given = split === -1 ? undefined : body.slice(split + 1)
    if (given === undefined && !toggles.has(flag)) {
      const next = tokens[index]
      if (next !== undefined && !next.startsWith("--")) {
        given = next
        index += 1
      }
    }
    const key = names.get(flag)
    if (key === undefined) {
      problems.push(`unknown option: --${flag} (known: ${known})`)
      continue
    }
    if (given === undefined && toggles.has(flag)) given = "true"
    if (given === undefined) {
      problems.push(`--${flag}: expected a value`)
      continue
    }
    if (raw[key] !== undefined) {
      problems.push(`--${flag}: given twice`)
      continue
    }
    raw[key] = given
  }
  if (problems.length > 0) return Effect.fail(new ArgsError({ problems }))
  return Schema.decodeUnknown(Schema.Struct(spec.fields))(raw, { errors: "all" }).pipe(
    Effect.mapError((error) => new ArgsError({ problems: describe(error) })),
    Effect.map((options) => ({ verb, options }))
  )
}
