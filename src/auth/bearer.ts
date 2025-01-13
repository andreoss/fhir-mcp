import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import { Unauthorized } from "./failure.js"
import type { Denial } from "./failure.js"

export interface Presented {
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly query?: Readonly<Record<string, string | undefined>> | undefined
}

const CARRIED = ["access_token", "token", "bearer_token"]

const presented = (headers: Readonly<Record<string, string | undefined>>): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return value
  }
  return undefined
}

export const bearer = (request: Presented): Effect.Effect<string, Denial> => {
  const query = request.query
  if (query !== undefined && CARRIED.some((name) => query[name] !== undefined)) {
    return Effect.fail(new Rejected({ reason: "an access token in a query string is refused" }))
  }
  const header = presented(request.headers)?.trim()
  if (header === undefined || header.length === 0) {
    return Effect.fail(new Unauthorized({ reason: "authorization required" }))
  }
  const parts = header.split(/\s+/)
  const scheme = parts[0]
  const token = parts[1]
  if (parts.length !== 2 || scheme?.toLowerCase() !== "bearer" || token === undefined) {
    return Effect.fail(new Rejected({ reason: "the authorization header is malformed" }))
  }
  return Effect.succeed(token)
}
