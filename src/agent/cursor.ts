import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const key = randomBytes(32)

export interface Position {
  readonly type: string
  readonly parameters: ReadonlyArray<readonly [string, string]>
  readonly offset: number
}

const shapeOf = (type: string, parameters: ReadonlyArray<readonly [string, string]>): string =>
  JSON.stringify([type, [...parameters].map(([name, value]) => `${name}=${value}`).sort()])

const sign = (payload: string): string =>
  createHmac("sha256", key).update(payload).digest("base64url")

export const issue = (position: Position): string => {
  const payload = Buffer.from(
    JSON.stringify({ s: sign(shapeOf(position.type, position.parameters)), o: position.offset })
  ).toString("base64url")
  return `${payload}.${sign(payload)}`
}

export const redeem = (
  token: string,
  type: string,
  parameters: ReadonlyArray<readonly [string, string]>
): { readonly offset: number } | undefined => {
  const parts = token.split(".")
  if (parts.length !== 2) return undefined
  const [payload, seal] = parts as [string, string]
  const expected = sign(payload)
  const given = Buffer.from(seal)
  const wanted = Buffer.from(expected)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      s: string
      o: number
    }
    if (decoded.s !== sign(shapeOf(type, parameters))) return undefined
    if (!Number.isInteger(decoded.o) || decoded.o < 0) return undefined
    return { offset: decoded.o }
  } catch {
    return undefined
  }
}
