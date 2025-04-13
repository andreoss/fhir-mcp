import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { Forbidden, Rejected } from "../core/outcome.js"
import type { Denial } from "./failure.js"
import { METHOD } from "./pkce.js"
import { Clock } from "./ports.js"

export interface Policy {
  readonly software: ReadonlyArray<string>
  readonly redirects: ReadonlyArray<string>
  readonly max: number
}

export interface Request {
  readonly software: string
  readonly name: string
  readonly redirects: ReadonlyArray<string>
}

export interface Client {
  readonly id: string
  readonly software: string
  readonly name: string
  readonly redirects: ReadonlyArray<string>
  readonly method: "none"
  readonly challenge: typeof METHOD
  readonly registered: number
}

export interface Registry {
  readonly kept: Map<string, Client>
}

export const registry = (): Registry => ({ kept: new Map() })

export const count = (registry: Registry): number => registry.kept.size

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

const problem = (address: string, hosts: ReadonlyArray<string>): string | undefined => {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return `not a redirect address: ${address}`
  }
  const loopback = LOOPBACK.has(url.hostname)
  if (!loopback && url.protocol !== "https:") {
    return `a redirect address must be secure or loopback: ${address}`
  }
  if (!loopback && hosts.length > 0 && !hosts.includes(url.origin)) {
    return `a redirect address at ${url.origin} is not configured`
  }
  return undefined
}

export const register = (
  registry: Registry,
  policy: Policy,
  request: Request
): Effect.Effect<Client, Denial, Clock> =>
  Effect.gen(function* () {
    if (policy.software.length === 0) {
      return yield* Effect.fail(new Rejected({ reason: "client registration is not open" }))
    }
    if (!policy.software.includes(request.software)) {
      return yield* Effect.fail(new Forbidden({ action: `register ${request.software}` }))
    }
    if (registry.kept.size >= policy.max) {
      return yield* Effect.fail(
        new Rejected({ reason: "the configured number of clients is already registered" })
      )
    }
    if (request.redirects.length === 0) {
      return yield* Effect.fail(new Rejected({ reason: "a redirect address is required" }))
    }
    for (const address of request.redirects) {
      const found = problem(address, policy.redirects)
      if (found !== undefined) return yield* Effect.fail(new Rejected({ reason: found }))
    }
    const clock = yield* Clock
    const id = randomBytes(16).toString("base64url")
    const client: Client = {
      id,
      software: request.software,
      name: request.name,
      redirects: [...request.redirects],
      method: "none",
      challenge: METHOD,
      registered: clock.seconds()
    }
    registry.kept.set(id, client)
    return client
  })
