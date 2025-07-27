import { Data, Effect, ParseResult, Schema } from "effect"
import { BackendRejected, parse } from "../emr/backend.js"
import type { BackendConfig, BackendInput } from "../emr/backend.js"
import { SECRET_KEY_ENV, open } from "./secrets.js"

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
  FHIR_ALLOW_WRITE: Schema.optionalWith(oneOf("false", "true"), { default: () => "false" as const }),
  FHIR_SCOPES: Schema.optionalWith(OriginList, { default: () => [] as ReadonlyArray<string> }),
  FHIR_TERMINOLOGY_DIR: Schema.optional(Schema.String),
  FHIR_LOG_LEVEL: Schema.optionalWith(oneOf("debug", "info", "warn", "error"), {
    default: () => "info" as const
  }),
  FHIR_TRAIL_PATH: Schema.optionalWith(Schema.String, { default: () => ":memory:" }),
  FHIR_TRAIL_KEY: Schema.optional(Schema.String),
  FHIR_TRAIL_RETENTION_MS: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative()).annotations({
      message: (issue) =>
        `expected a non-negative whole number of milliseconds, got ${JSON.stringify(issue.actual)}`
    }),
    { default: () => 0 }
  )
})

export type Transport = typeof Fields.Type["FHIR_TRANSPORT"]
export type LogLevel = typeof Fields.Type["FHIR_LOG_LEVEL"]

const EMR_PREFIX = "FHIR_EMR"

const EMR = {
  BACKEND: "FHIR_EMR_BACKEND",
  BASE_URL: "FHIR_EMR_BASE_URL",
  PROVIDER: "FHIR_EMR_PROVIDER",
  TIMEOUT_MS: "FHIR_EMR_TIMEOUT_MS",
  RETRY_AFTER_MS: "FHIR_EMR_RETRY_AFTER_MS",
  AUTH_SCHEME: "FHIR_EMR_AUTH_SCHEME",
  AUTH_TOKEN: "FHIR_EMR_AUTH_TOKEN",
  AUTH_USERNAME: "FHIR_EMR_AUTH_USERNAME",
  AUTH_PASSWORD: "FHIR_EMR_AUTH_PASSWORD",
  AUTH_TOKEN_URL: "FHIR_EMR_AUTH_TOKEN_URL",
  AUTH_CLIENT_ID: "FHIR_EMR_AUTH_CLIENT_ID",
  AUTH_KID: "FHIR_EMR_AUTH_KID",
  AUTH_KEY: "FHIR_EMR_AUTH_KEY",
  AUTH_SCOPE: "FHIR_EMR_AUTH_SCOPE",
  AUTH_ASSERTION_LIFETIME_MS: "FHIR_EMR_AUTH_ASSERTION_LIFETIME_MS",
  AUTH_REFRESH_MARGIN_MS: "FHIR_EMR_AUTH_REFRESH_MARGIN_MS"
} as const

export interface Config {
  readonly transport: Transport
  readonly http: {
    readonly host: string
    readonly port: number
    readonly origins: ReadonlyArray<string>
  }
  readonly store: { readonly path: string }
  readonly allowWrite: boolean
  readonly scopes: ReadonlyArray<string>
  readonly terminologyDir: string | undefined
  readonly logLevel: LogLevel
  readonly trail: { readonly path: string; readonly key: string; readonly retentionMs: number }
  readonly emr?: BackendConfig
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

const trailKeyOf = (
  raw: string | undefined,
  passphrase: string | undefined
): string | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : open(trimmed, passphrase)
}

const trailProblems = (
  decoded: typeof Fields.Type,
  key: string | undefined
): ReadonlyArray<string> =>
  decoded.FHIR_TRAIL_PATH === ":memory:" || key !== undefined
    ? []
    : ["FHIR_TRAIL_KEY: a durable audit trail needs a sealing key"]

const crossFieldProblems = (decoded: typeof Fields.Type): ReadonlyArray<string> => {
  if (decoded.FHIR_TRANSPORT !== "http") return []
  if (decoded.FHIR_HTTP_ORIGINS.length > 0) return []
  const reason = loopback.has(decoded.FHIR_HTTP_HOST)
    ? "serving over http requires an allow list of origins"
    : `serving over http on ${decoded.FHIR_HTTP_HOST} requires an allow list of origins`
  return [`FHIR_HTTP_ORIGINS: ${reason}`]
}

const shape = (decoded: typeof Fields.Type, trailKey: string): Config => ({
  transport: decoded.FHIR_TRANSPORT,
  http: {
    host: decoded.FHIR_HTTP_HOST,
    port: decoded.FHIR_HTTP_PORT,
    origins: decoded.FHIR_HTTP_ORIGINS
  },
  store: { path: decoded.FHIR_STORE_PATH },
  allowWrite: decoded.FHIR_ALLOW_WRITE === "true",
  scopes: decoded.FHIR_SCOPES,
  terminologyDir: decoded.FHIR_TERMINOLOGY_DIR,
  logLevel: decoded.FHIR_LOG_LEVEL,
  trail: {
    path: decoded.FHIR_TRAIL_PATH,
    key: trailKey ?? "",
    retentionMs: decoded.FHIR_TRAIL_RETENTION_MS
  }
})

const FIELD_ENV: Readonly<Record<string, string>> = {
  name: EMR.BACKEND,
  baseUrl: EMR.BASE_URL,
  provider: EMR.PROVIDER,
  timeoutMs: EMR.TIMEOUT_MS,
  retryAfterMs: EMR.RETRY_AFTER_MS,
  "auth.scheme": EMR.AUTH_SCHEME,
  "auth.token": EMR.AUTH_TOKEN,
  "auth.username": EMR.AUTH_USERNAME,
  "auth.password": EMR.AUTH_PASSWORD,
  "auth.tokenUrl": EMR.AUTH_TOKEN_URL,
  "auth.clientId": EMR.AUTH_CLIENT_ID,
  "auth.kid": EMR.AUTH_KID,
  "auth.key": EMR.AUTH_KEY,
  "auth.assertionLifetimeMs": EMR.AUTH_ASSERTION_LIFETIME_MS,
  "auth.refreshMarginMs": EMR.AUTH_REFRESH_MARGIN_MS
}

const anyEmr = (env: Record<string, string | undefined>): boolean =>
  Object.keys(env).some((key) => key.startsWith(EMR_PREFIX))

const SECRET_FIELDS: ReadonlySet<string> = new Set([
  EMR.AUTH_TOKEN,
  EMR.AUTH_PASSWORD,
  EMR.AUTH_KEY
])

const readEmr = (
  env: Record<string, string | undefined>,
  problems: Array<string>
): BackendConfig | undefined => {
  if (!anyEmr(env)) return undefined
  const secretKey = env[SECRET_KEY_ENV]
  let refused: string | undefined
  const value = (field: string): string | undefined => {
    if (refused !== undefined) return undefined
    const raw = env[field]
    if (raw === undefined) return undefined
    const trimmed = raw.trim()
    if (trimmed.length === 0) return raw
    if (!SECRET_FIELDS.has(field)) return raw
    try {
      return open(trimmed, secretKey)
    } catch (error) {
      refused = `${field}: ${error instanceof Error ? error.message : String(error)}`
      return undefined
    }
  }
  const input: BackendInput = {
    name: value(EMR.BACKEND),
    baseUrl: value(EMR.BASE_URL),
    provider: value(EMR.PROVIDER),
    timeoutMs: value(EMR.TIMEOUT_MS),
    retryAfterMs: value(EMR.RETRY_AFTER_MS),
    auth: {
      scheme: value(EMR.AUTH_SCHEME),
      token: value(EMR.AUTH_TOKEN),
      username: value(EMR.AUTH_USERNAME),
      password: value(EMR.AUTH_PASSWORD),
      tokenUrl: value(EMR.AUTH_TOKEN_URL),
      clientId: value(EMR.AUTH_CLIENT_ID),
      kid: value(EMR.AUTH_KID),
      key: value(EMR.AUTH_KEY),
      scope: value(EMR.AUTH_SCOPE),
      assertionLifetimeMs: value(EMR.AUTH_ASSERTION_LIFETIME_MS),
      refreshMarginMs: value(EMR.AUTH_REFRESH_MARGIN_MS)
    }
  }
  if (refused !== undefined) {
    problems.push(refused)
    return undefined
  }
  try {
    return parse(input)
  } catch (error) {
    if (error instanceof BackendRejected) {
      for (const problem of error.problems) {
        const key = FIELD_ENV[problem.field]
        problems.push(key === undefined ? problem.message : `${key}: ${problem.message}`)
      }
    } else {
      problems.push(`emr: ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  }
}

export const load = (
  env: Record<string, string | undefined>
): Effect.Effect<Config, ConfigError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(Fields)(present(env), { errors: "all" }).pipe(
      Effect.mapError((error) => new ConfigError({ problems: describe(error) }))
    )
    const problems: Array<string> = [...crossFieldProblems(decoded)]
    let trailKey: string | undefined
    try {
      trailKey = trailKeyOf(env["FHIR_TRAIL_KEY"], env[SECRET_KEY_ENV])
    } catch (error) {
      problems.push(
        `FHIR_TRAIL_KEY: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    problems.push(...trailProblems(decoded, trailKey))
    const emr = readEmr(env, problems)
    if (problems.length > 0) {
      return yield* Effect.fail(new ConfigError({ problems }))
    }
    const config = shape(decoded, trailKey ?? "")
    return emr === undefined ? config : { ...config, emr }
  })
