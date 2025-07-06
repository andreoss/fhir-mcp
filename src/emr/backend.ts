export type ProviderName = "generic" | "smart"

export interface AuthHttpBearer {
  readonly scheme: "bearer"
  readonly token: string
}

export interface AuthHttpBasic {
  readonly scheme: "basic"
  readonly username: string
  readonly password: string
}

export interface AuthSmart {
  readonly scheme: "smart"
  readonly tokenUrl: string
  readonly clientId: string
  readonly kid: string
  readonly key: string
  readonly scope?: string
  readonly assertionLifetimeMs: number
  readonly refreshMarginMs: number
}

export interface AuthNone {
  readonly scheme: "none"
}

export type Auth = AuthNone | AuthHttpBearer | AuthHttpBasic | AuthSmart

export interface BackendConfig {
  readonly name: string
  readonly baseUrl: string
  readonly provider: ProviderName
  readonly timeoutMs: number
  readonly retryAfterMs: number
  readonly auth: Auth
}

export class MissingField extends Error {
  readonly field: string
  readonly backend: string
  constructor(backend: string, field: string) {
    super(`${backend}: ${field} must be set and not blank`)
    this.name = "MissingField"
    this.field = field
    this.backend = backend
  }
}

export class InvalidValue extends Error {
  readonly field: string
  readonly backend: string
  constructor(backend: string, field: string, detail: string) {
    super(`${backend}: ${field} ${detail}`)
    this.name = "InvalidValue"
    this.field = field
    this.backend = backend
  }
}

export type FieldProblem = MissingField | InvalidValue

export class BackendRejected extends Error {
  readonly problems: ReadonlyArray<FieldProblem>
  constructor(problems: ReadonlyArray<FieldProblem>) {
    super(problems.map((problem) => problem.message).join("; "))
    this.name = "BackendRejected"
    this.problems = problems
  }
}

export interface BackendInput {
  readonly name?: string | undefined
  readonly baseUrl?: string | undefined
  readonly provider?: string | undefined
  readonly timeoutMs?: string | undefined
  readonly retryAfterMs?: string | undefined
  readonly auth?: {
    readonly scheme?: string | undefined
    readonly token?: string | undefined
    readonly username?: string | undefined
    readonly password?: string | undefined
    readonly tokenUrl?: string | undefined
    readonly clientId?: string | undefined
    readonly kid?: string | undefined
    readonly key?: string | undefined
    readonly scope?: string | undefined
    readonly assertionLifetimeMs?: string | undefined
    readonly refreshMarginMs?: string | undefined
  } | undefined
}

const PROVIDERS = ["generic", "smart"] as const
const SCHEMES = ["none", "bearer", "basic", "smart"] as const

const named = (
  backend: string,
  field: string,
  value: unknown,
  problems: Array<FieldProblem>
): string | undefined => {
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(new MissingField(backend, field))
    return undefined
  }
  return value.trim()
}

const positive = (
  backend: string,
  field: string,
  value: unknown,
  problems: Array<FieldProblem>
): number | undefined => {
  const text = named(backend, field, value, problems)
  if (text === undefined) return undefined
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    problems.push(
      new InvalidValue(
        backend,
        field,
        `must be a number greater than zero, got ${JSON.stringify(text)}`
      )
    )
    return undefined
  }
  return parsed
}

const chosen = <A extends string>(
  backend: string,
  field: string,
  value: unknown,
  values: ReadonlyArray<A>,
  problems: Array<FieldProblem>
): A | undefined => {
  const text = named(backend, field, value, problems)
  if (text === undefined) return undefined
  const found = values.find((one) => one === text)
  if (found !== undefined) return found
  const accepted = values.map((one) => `"${one}"`).join(", ")
  problems.push(
    new InvalidValue(backend, field, `must be one of ${accepted}, got ${JSON.stringify(text)}`)
  )
  return undefined
}

const authOf = (
  backend: string,
  input: BackendInput["auth"],
  problems: Array<FieldProblem>
): Auth | undefined => {
  const scheme = chosen(backend, "auth.scheme", input?.scheme, SCHEMES, problems)
  if (scheme === undefined) return undefined
  switch (scheme) {
    case "none":
      return { scheme: "none" }
    case "bearer": {
      const token = named(backend, "auth.token", input?.token, problems)
      return token === undefined ? undefined : { scheme: "bearer", token }
    }
    case "basic": {
      const username = named(backend, "auth.username", input?.username, problems)
      const password = named(backend, "auth.password", input?.password, problems)
      return username === undefined || password === undefined
        ? undefined
        : { scheme: "basic", username, password }
    }
    case "smart": {
      const tokenUrl = named(backend, "auth.tokenUrl", input?.tokenUrl, problems)
      const clientId = named(backend, "auth.clientId", input?.clientId, problems)
      const kid = named(backend, "auth.kid", input?.kid, problems)
      const key = named(backend, "auth.key", input?.key, problems)
      const assertionLifetimeMs = positive(
        backend,
        "auth.assertionLifetimeMs",
        input?.assertionLifetimeMs,
        problems
      )
      const refreshMarginMs = positive(
        backend,
        "auth.refreshMarginMs",
        input?.refreshMarginMs,
        problems
      )
      if (
        tokenUrl === undefined ||
        clientId === undefined ||
        kid === undefined ||
        key === undefined ||
        assertionLifetimeMs === undefined ||
        refreshMarginMs === undefined
      ) {
        return undefined
      }
      const scope = input?.scope?.trim()
      return {
        scheme: "smart",
        tokenUrl,
        clientId,
        kid,
        key,
        assertionLifetimeMs,
        refreshMarginMs,
        ...(scope === undefined || scope.length === 0 ? {} : { scope })
      }
    }
  }
}

export const parse = (input: BackendInput): BackendConfig => {
  const problems: Array<FieldProblem> = []
  const name = named("backend", "name", input.name, problems)
  const owner = name ?? "backend"
  const baseUrl = named(owner, "baseUrl", input.baseUrl, problems)
  const provider = chosen(owner, "provider", input.provider, PROVIDERS, problems)
  const timeoutMs = positive(owner, "timeoutMs", input.timeoutMs, problems)
  const retryAfterMs = positive(owner, "retryAfterMs", input.retryAfterMs, problems)
  const auth = authOf(owner, input.auth, problems)
  if (
    problems.length > 0 ||
    name === undefined ||
    baseUrl === undefined ||
    provider === undefined ||
    timeoutMs === undefined ||
    retryAfterMs === undefined ||
    auth === undefined
  ) {
    throw new BackendRejected(problems)
  }
  return { name, baseUrl, provider, timeoutMs, retryAfterMs, auth }
}

export const select = (configs: ReadonlyArray<BackendConfig>, name: string): BackendConfig | undefined =>
  configs.find((c) => c.name === name)
