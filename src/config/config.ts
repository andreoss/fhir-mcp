import { Data, Effect, ParseResult, Schema } from "effect"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly problems: ReadonlyArray<string>
}> {
  override get message(): string {
    return `configuration rejected:\n  ${this.problems.join("\n  ")}`
  }
}

const oneOf = <A extends string>(...values: ReadonlyArray<A>) =>
  Schema.Literal(...values).annotations({
    message: (issue) =>
      `expected one of ${values.map((v) => `"${v}"`).join(", ")}, got ${JSON.stringify(issue.actual)}`
  })

const Port = Schema.NumberFromString.pipe(
  Schema.int(),
  Schema.between(1, 65535)
).annotations({
  message: (issue) => `expected a port between 1 and 65535, got ${JSON.stringify(issue.actual)}`
})

const OriginList = Schema.transform(
  Schema.String,
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (raw) => raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0),
    encode: (list) => list.join(",")
  }
)

const Fields = Schema.Struct({
  FHIR_TRANSPORT: Schema.optionalWith(oneOf("stdio", "http"), { default: () => "stdio" as const }),
  FHIR_HTTP_HOST: Schema.optionalWith(Schema.String, { default: () => "127.0.0.1" }),
  FHIR_HTTP_PORT: Schema.optionalWith(Port, { default: () => 8080 }),
  FHIR_HTTP_ORIGINS: Schema.optionalWith(OriginList, { default: () => [] as ReadonlyArray<string> }),
  FHIR_STORE_PATH: Schema.optionalWith(Schema.String, { default: () => ":memory:" }),
  FHIR_TERMINOLOGY_DIR: Schema.optional(Schema.String),
  FHIR_LOG_LEVEL: Schema.optionalWith(oneOf("debug", "info", "warn", "error"), {
    default: () => "info" as const
  })
})

export type Transport = typeof Fields.Type["FHIR_TRANSPORT"]
export type LogLevel = typeof Fields.Type["FHIR_LOG_LEVEL"]

export interface Config {
  readonly transport: Transport
  readonly http: {
    readonly host: string
    readonly port: number
    readonly origins: ReadonlyArray<string>
  }
  readonly store: { readonly path: string }
  readonly terminologyDir: string | undefined
  readonly logLevel: LogLevel
}

const loopback = new Set(["127.0.0.1", "::1", "localhost"])

const present = (env: Record<string, string | undefined>) => {
  const owned: Record<string, string> = {}
  for (const key of Object.keys(Fields.fields)) {
    const raw = env[key]
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    owned[key] = trimmed
  }
  return owned
}

const describe = (error: ParseResult.ParseError): ReadonlyArray<string> => {
  const byKey = new Map<string, Set<string>>()
  for (const issue of ParseResult.ArrayFormatter.formatErrorSync(error)) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "configuration"
    const seen = byKey.get(key) ?? new Set<string>()
    seen.add(issue.message)
    byKey.set(key, seen)
  }
  return [...byKey].map(([key, messages]) => `${key}: ${[...messages].join("; ")}`)
}

const crossFieldProblems = (decoded: typeof Fields.Type): ReadonlyArray<string> => {
  if (decoded.FHIR_TRANSPORT !== "http") return []
  if (decoded.FHIR_HTTP_ORIGINS.length > 0) return []
  const reason = loopback.has(decoded.FHIR_HTTP_HOST)
    ? "serving over http requires an allow list of origins"
    : `serving over http on ${decoded.FHIR_HTTP_HOST} requires an allow list of origins`
  return [`FHIR_HTTP_ORIGINS: ${reason}`]
}

const shape = (decoded: typeof Fields.Type): Config => ({
  transport: decoded.FHIR_TRANSPORT,
  http: {
    host: decoded.FHIR_HTTP_HOST,
    port: decoded.FHIR_HTTP_PORT,
    origins: decoded.FHIR_HTTP_ORIGINS
  },
  store: { path: decoded.FHIR_STORE_PATH },
  terminologyDir: decoded.FHIR_TERMINOLOGY_DIR,
  logLevel: decoded.FHIR_LOG_LEVEL
})

export const load = (
  env: Record<string, string | undefined>
): Effect.Effect<Config, ConfigError> =>
  Schema.decodeUnknown(Fields)(present(env), { errors: "all" }).pipe(
    Effect.mapError((error) => new ConfigError({ problems: describe(error) })),
    Effect.flatMap((decoded) => {
      const problems = crossFieldProblems(decoded)
      return problems.length > 0
        ? Effect.fail(new ConfigError({ problems }))
        : Effect.succeed(shape(decoded))
    })
  )
