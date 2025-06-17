import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"

export const PREFIX = "enc:v1:"

export const SECRET_KEY_ENV = "FHIR_SECRET_KEY" as const

const SALT = "fhir-mcp-secrets-v1"

const keyOf = (passphrase: string): Buffer => scryptSync(passphrase, SALT, 32)

export const isSealed = (value: string): boolean => value.startsWith(PREFIX)

export class SecretRefused extends Error {
  readonly detail: string
  constructor(detail: string) {
    super(detail)
    this.name = "SecretRefused"
    this.detail = detail
  }
}

export const seal = (plain: string, passphrase: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyOf(passphrase), iv)
  const sealed = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${sealed.toString("base64url")}`
}

export const unseal = (stored: string, passphrase: string | undefined): string => {
  if (passphrase === undefined || passphrase.trim().length === 0) {
    throw new SecretRefused("sealed but no decryption key is set")
  }
  const [ivText, tagText, dataText] = stored.slice(PREFIX.length).split(".")
  if (ivText === undefined || tagText === undefined || dataText === undefined) {
    throw new SecretRefused("the sealed value is malformed")
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyOf(passphrase),
      Buffer.from(ivText, "base64url")
    )
    decipher.setAuthTag(Buffer.from(tagText, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(dataText, "base64url")),
      decipher.final()
    ]).toString("utf-8")
  } catch {
    throw new SecretRefused("decryption failed")
  }
}

export const open = (raw: string, passphrase: string | undefined): string =>
  isSealed(raw) ? unseal(raw, passphrase) : raw