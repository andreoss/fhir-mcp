import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Unavailable } from "../core/outcome.js"
import { sealed } from "./incumbent.js"
import type { Incumbent } from "./incumbent.js"
import { fake } from "./fake.js"
import { survey, tally } from "./survey.js"
import type { Version } from "../core/interactions.js"

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const of = (type: string, id: string, versionId: number, deleted = false): Version => ({
  type,
  id,
  versionId,
  lastUpdated: moment(versionId),
  deleted,
  body: deleted ? { resourceType: type, id } : { resourceType: type, id, name: [{ family: id }] }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const held: ReadonlyArray<Version> = [
  of("Observation", "o1", 1),
  of("Patient", "p1", 2),
  of("Patient", "p1", 1),
  of("Patient", "p2", 1),
  of("Patient", "p2", 2, true)
]

describe("incumbent survey", () => {
  it("gathers schema, types, every version and the search state", async () => {
    const found = await run(survey(sealed(fake(held))))
    expect(found.schema.version).toBeGreaterThan(0)
    expect(found.type).toEqual(["Observation", "Patient"])
    expect(found.record).toHaveLength(5)
    expect(found.search.length).toBeGreaterThan(0)
  })

  it("orders the records by type, id and version", async () => {
    const found = await run(survey(sealed(fake(held))))
    expect(found.record.map((one) => `${one.type}/${one.id}/${one.versionId}`)).toEqual([
      "Observation/o1/1",
      "Patient/p1/1",
      "Patient/p1/2",
      "Patient/p2/1",
      "Patient/p2/2"
    ])
  })

  it("counts resources, versions and delete markers apart", async () => {
    const counted = tally(await run(survey(sealed(fake(held)))))
    expect(counted).toEqual({ types: 2, resources: 3, versions: 5, deletes: 1 })
  })

  it("surveys an empty incumbent", async () => {
    const counted = tally(await run(survey(sealed(fake([])))))
    expect(counted).toEqual({ types: 0, resources: 0, versions: 0, deletes: 0 })
  })

  it("orders records the incumbent hands back in its own order", async () => {
    const source = fake(held)
    const shuffled: Incumbent = {
      ...source,
      types: () => Effect.succeed(["Patient", "Observation"]),
      records: (type) => Effect.map(source.records(type), (found) => [...found].reverse())
    }
    const found = await run(survey(sealed(shuffled)))
    expect(found.record.map((one) => one.type + "/" + one.id + "/" + one.versionId)).toEqual([
      "Observation/o1/1",
      "Patient/p1/1",
      "Patient/p1/2",
      "Patient/p2/1",
      "Patient/p2/2"
    ])
  })

  it("carries a read failure out rather than reporting an empty store", async () => {
    const broken: Incumbent = {
      ...fake(held),
      records: () => Effect.fail(new Unavailable({ dependency: "incumbent" }))
    }
    const result = await Effect.runPromiseExit(survey(sealed(broken)))
    expect(Exit.isFailure(result)).toBe(true)
  })
})
