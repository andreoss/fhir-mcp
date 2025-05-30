import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const PAGE_SIZE = 5

const secret = randomBytes(32)

interface Payload {
  readonly s: string
  readonly i: number
  readonly n: string
}

const sign = (data: string): string =>
  createHmac("sha256", secret).update(data).digest("base64url")

const encode = (offset: number, scope: string): string => {
  const data = Buffer.from(
    JSON.stringify({ s: scope, i: offset, n: randomBytes(6).toString("base64url") })
  ).toString("base64url")
  return `${data}.${sign(data)}`
}

const decode = (cursor: string, scope: string): number | undefined => {
  const cut = cursor.lastIndexOf(".")
  if (cut <= 0) return undefined
  const data = cursor.slice(0, cut)
  let claimed: Buffer
  let payload: Payload
  try {
    claimed = Buffer.from(cursor.slice(cut + 1), "base64url")
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Payload
  } catch {
    return undefined
  }
  const expected = Buffer.from(sign(data), "base64url")
  if (claimed.length !== expected.length || !timingSafeEqual(claimed, expected)) return undefined
  if (payload.s !== scope || !Number.isInteger(payload.i) || payload.i < 0) return undefined
  return payload.i
}

export interface Page<T> {
  readonly page: ReadonlyArray<T>
  readonly nextCursor?: string
}

export const paginate = <T>(
  items: ReadonlyArray<T>,
  cursor: string | undefined,
  scope: string,
  pageSize: number = PAGE_SIZE
): Page<T> | undefined => {
  const offset = cursor === undefined ? 0 : decode(cursor, scope)
  if (offset === undefined) return undefined
  const page = items.slice(offset, offset + pageSize)
  const after = offset + page.length
  if (after < items.length) return { page, nextCursor: encode(after, scope) }
  return { page }
}