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

export const blank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)

export const required = (backend: string, field: string, value: unknown): string => {
  if (typeof value !== "string") throw new MissingField(backend, field)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new MissingField(backend, field)
  return trimmed
}

export const requiredPositive = (backend: string, field: string, value: unknown): number => {
  const number = required(backend, field, value)
  const parsed = Number(number)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new MissingField(backend, field)
  return parsed
}

export interface BackendInput {
  readonly name: string
  readonly baseUrl: string
  readonly provider?: string
  readonly timeoutMs?: string
  readonly retryAfterMs?: string
  readonly auth?: {
    readonly scheme?: string | undefined
    readonly token?: string | undefined
    readonly username?: string | undefined
    readonly password?: string | undefined
    readonly tokenUrl?: string | undefined
    readonly clientId?: string | undefined
    readonly kid?: string | undefined
    readonly assertionLifetimeMs?: string | undefined
    readonly refreshMarginMs?: string | undefined
  } | undefined
}

export const parse = (input: BackendInput): BackendConfig => {
  const name = required("backend", "name", input.name)
  const baseUrl = required(name, "baseUrl", input.baseUrl)
  const providerSpec = input.provider ?? "generic"
  const provider = providerSpec === "generic" || providerSpec === "smart"
    ? providerSpec
    : (() => {
      throw new MissingField(name, "provider")
    })()
  const timeoutMs = requiredPositive(name, "timeoutMs", input.timeoutMs)
  const retryAfterMs = requiredPositive(name, "retryAfterMs", input.retryAfterMs)

  const scheme = input.auth === undefined ? "none" : required(name, "auth.scheme", input.auth?.scheme)
  let auth: Auth
  switch (scheme) {
    case "none":
      auth = { scheme: "none" }
      break
    case "bearer":
      auth = { scheme: "bearer", token: required(name, "auth.token", input.auth?.token) }
      break
    case "basic":
      auth = {
        scheme: "basic",
        username: required(name, "auth.username", input.auth?.username),
        password: required(name, "auth.password", input.auth?.password)
      }
      break
    case "smart":
      auth = {
        scheme: "smart",
        tokenUrl: required(name, "auth.tokenUrl", input.auth?.tokenUrl),
        clientId: required(name, "auth.clientId", input.auth?.clientId),
        kid: required(name, "auth.kid", input.auth?.kid),
        assertionLifetimeMs: requiredPositive(name, "auth.assertionLifetimeMs", input.auth?.assertionLifetimeMs),
        refreshMarginMs: requiredPositive(name, "auth.refreshMarginMs", input.auth?.refreshMarginMs)
      }
      break
    default:
      throw new MissingField(name, "auth.scheme")
  }

  return { name, baseUrl, provider, timeoutMs, retryAfterMs, auth }
}

export const select = (configs: ReadonlyArray<BackendConfig>, name: string): BackendConfig | undefined =>
  configs.find((c) => c.name === name)
