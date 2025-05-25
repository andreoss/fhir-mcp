import { Context, Effect, Layer, Ref } from "effect"
import type { OperationOutcome } from "../core/outcome.js"
import type { ToolResult } from "./tools.js"

export interface Rate {
  readonly burst: number
  readonly perSecond: number
}

export interface Limit {
  readonly session: Rate
  readonly tool: Rate
  readonly inFlight: number
}

export const DEFAULT_LIMIT: Limit = {
  session: { burst: 10, perSecond: 1 },
  tool: { burst: 25, perSecond: 5 },
  inFlight: 2
}

export interface Bucket {
  readonly capacity: number
  readonly ratePerSecond: number
  readonly stored: number
  readonly refilledAt: number
}

export const fresh = (rate: Rate, now: number): Bucket => ({
  capacity: rate.burst,
  ratePerSecond: rate.perSecond,
  stored: rate.burst,
  refilledAt: now
})

export const refilled = (bucket: Bucket, now: number): Bucket => {
  if (now < bucket.refilledAt) return bucket
  const gained = Math.floor(((now - bucket.refilledAt) / 1000) * bucket.ratePerSecond)
  return {
    ...bucket,
    stored: Math.min(bucket.capacity, bucket.stored + gained),
    refilledAt: now
  }
}

export const draw = (
  bucket: Bucket,
  _now: number
): { readonly bucket: Bucket; readonly allows: boolean; readonly missing: number } => {
  if (bucket.stored >= 1) {
    return { bucket: { ...bucket, stored: bucket.stored - 1 }, allows: true, missing: 0 }
  }
  return { bucket, allows: false, missing: Math.max(0, 1 - bucket.stored) }
}

export type Admission =
  | { readonly kind: "permit"; readonly release: Effect.Effect<void, never, never> }
  | { readonly kind: "refused"; readonly retryAfterSeconds: number }

export class CurrentSession extends Context.Tag("AgentCurrentSession")<
  CurrentSession,
  { readonly id: string }
>() {}
export class Limiter extends Context.Tag("AgentRateLimiter")<Limiter, {
  readonly check: (name: string, sessionId: string) => Effect.Effect<Admission, never, never>
}>() {}

interface State {
  readonly session: Readonly<Record<string, Bucket>>
  readonly tool: Readonly<Record<string, Bucket>>
  readonly inFlight: number
}

const admit = (
  ref: Ref.Ref<State>,
  held: State,
  sessionId: string,
  now: number,
  limit: Limit
): readonly [Admission, State] => {
  const session = refilled(held.session[sessionId] ?? fresh(limit.session, now), now)
  const tool = refilled(held.tool[sessionId] ?? fresh(limit.tool, now), now)
  const sessionDraw = draw(session, now)
  const toolDraw = draw(tool, now)
  const record: State = {
    session: { ...held.session, [sessionId]: sessionDraw.bucket },
    tool: { ...held.tool, [sessionId]: toolDraw.bucket },
    inFlight: held.inFlight
  }
  if (sessionDraw.allows && toolDraw.allows && held.inFlight < limit.inFlight) {
    return [
      { kind: "permit", release: Ref.update(ref, (done) => ({ ...done, inFlight: done.inFlight - 1 })) },
      { ...record, inFlight: held.inFlight + 1 }
    ]
  }
  const seconds = Math.ceil(
    Math.max(
      sessionDraw.missing / limit.session.perSecond,
      toolDraw.missing / limit.tool.perSecond
    )
  )
  return [{ kind: "refused", retryAfterSeconds: Math.max(1, seconds) }, record]
}

export const limiterOn = (limit: Limit): Layer.Layer<Limiter> =>
  Layer.scoped(
    Limiter,
    Effect.gen(function* () {
      const state = yield* Ref.make<State>({ session: {}, tool: {}, inFlight: 0 })
      return {
        check: (_name, sessionId) =>
          Effect.gen(function* () {
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            return yield* Ref.modify(state, (held) => admit(state, held, sessionId, now, limit))
          })
      }
    })
  )

export const limited = (tool: string, retryAfterSeconds: number): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(outcomeOf(tool, retryAfterSeconds)) }],
  isError: true
})

const outcomeOf = (tool: string, retryAfterSeconds: number): OperationOutcome => ({
  resourceType: "OperationOutcome",
  issue: [
    {
      severity: "error",
      code: "transient",
      diagnostics:
        `rate limit exceeded for ${tool}; ` +
        `retry after ${Math.max(1, Math.ceil(retryAfterSeconds))}s`
    }
  ]
})