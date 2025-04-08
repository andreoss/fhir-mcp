import { Data, Effect } from "effect"
import { readFile } from "node:fs/promises"
import type { Secure } from "../protocol/http.js"

export const TRANSPORT = "FHIR_TRANSPORT"

export const CERT_FILE = "FHIR_TLS_CERT_FILE"

export const KEY_FILE = "FHIR_TLS_KEY_FILE"

export const PASSPHRASE = "FHIR_TLS_PASSPHRASE"

export class TlsError extends Data.TaggedError("TlsError")<{
  readonly reason: string
}> {
  override get message(): string {
    return `encryption not terminated: ${this.reason}`
  }
}

export type Mode = "stdio" | "http" | "https"

export const modeOf = (env: Record<string, string | undefined>): Mode => {
  const asked = (env[TRANSPORT] ?? "stdio").trim()
  if (asked === "https") return "https"
  return asked === "http" ? "http" : "stdio"
}

export const asConfigured = (
  env: Record<string, string | undefined>,
  mode: Mode
): Record<string, string | undefined> =>
  mode === "https" ? { ...env, [TRANSPORT]: "http" } : env

export const terminated = (
  env: Record<string, string | undefined>
): Effect.Effect<Secure, TlsError> =>
  Effect.tryPromise({
    try: async () => {
      const cert = env[CERT_FILE]
      const key = env[KEY_FILE]
      if (cert === undefined || cert.trim().length === 0) {
        throw new Error(`${CERT_FILE} names no certificate`)
      }
      if (key === undefined || key.trim().length === 0) {
        throw new Error(`${KEY_FILE} names no key`)
      }
      const held = env[PASSPHRASE]
      return {
        cert: await readFile(cert.trim(), "utf8"),
        key: await readFile(key.trim(), "utf8"),
        passphrase: held === undefined || held.trim().length === 0 ? undefined : held
      }
    },
    catch: (cause) =>
      new TlsError({ reason: cause instanceof Error ? cause.message : "unreadable" })
  })
