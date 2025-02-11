import { Effect, Either } from "effect"
import type { Version, VersionedStore } from "../core/interactions.js"
import type { Failure } from "../core/outcome.js"
import type { Incumbent } from "./incumbent.js"
import { survey, tally } from "./survey.js"
import type { Tally } from "./survey.js"

const TYPE = /^[A-Z][A-Za-z]{1,63}$/
const ID = /^[A-Za-z0-9\-.]{1,64}$/

export interface Missed {
  readonly type: string
  readonly id: string
  readonly versionId: number
  readonly reason: string
}

export interface Report {
  readonly read: Tally
  readonly written: number
  readonly verified: number
  readonly missed: ReadonlyArray<Missed>
  readonly complete: boolean
}

export const named = (found: Report): ReadonlyArray<string> =>
  found.missed.map((one) => `${one.type}/${one.id}/_history/${one.versionId}`)

const refusal = (entry: Version): string | undefined => {
  if (!TYPE.test(entry.type)) return `type is not a resource type: ${entry.type}`
  if (!ID.test(entry.id)) return `id is not a resource id: ${entry.id}`
  if (!Number.isInteger(entry.versionId) || entry.versionId < 1) {
    return `version is not a version: ${entry.versionId}`
  }
  if (entry.body.resourceType !== entry.type) {
    return `body carries ${entry.body.resourceType}, not ${entry.type}`
  }
  return undefined
}

const missOf = (entry: Version, reason: string): Missed => ({
  type: entry.type,
  id: entry.id,
  versionId: entry.versionId,
  reason
})

export const migrate = (
  port: Incumbent,
  target: VersionedStore
): Effect.Effect<Report, Failure> =>
  Effect.gen(function* () {
    const found = yield* survey(port)
    const read = tally(found)
    const outcome: Array<Missed | undefined> = []
    for (const entry of found.record) {
      const refused = refusal(entry)
      if (refused !== undefined) {
        outcome.push(missOf(entry, refused))
        continue
      }
      const done = yield* Effect.either(target.insertVersion(entry))
      if (Either.isLeft(done)) {
        outcome.push(missOf(entry, `write refused: ${done.left._tag}`))
        continue
      }
      outcome.push(undefined)
    }
    const written = outcome.filter((one) => one === undefined).length
    for (const [at, entry] of found.record.entries()) {
      if (outcome[at] !== undefined) continue
      const back = yield* Effect.either(
        target.versionAt(entry.type, entry.id, entry.versionId)
      )
      if (Either.isLeft(back)) {
        outcome[at] = missOf(entry, `read back refused: ${back.left._tag}`)
        continue
      }
      const held = back.right
      if (held === undefined) {
        outcome[at] = missOf(entry, "not present after the write")
        continue
      }
      if (held.deleted !== entry.deleted) {
        outcome[at] = missOf(entry, "delete marker not carried")
      }
    }
    const missed = outcome.filter((one): one is Missed => one !== undefined)
    const verified = outcome.filter((one) => one === undefined).length
    const whole = verified === read.versions && written === read.versions
    return { read, written, verified, missed, complete: missed.length === 0 && whole }
  })
