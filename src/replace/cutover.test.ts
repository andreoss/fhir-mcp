import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { Version } from "../core/interactions.js"
import { Unavailable } from "../core/outcome.js"
import { sealed } from "./incumbent.js"
import type { Incumbent } from "./incumbent.js"
import { fake } from "./fake.js"
import type { Fake } from "./fake.js"
import { survey } from "./survey.js"
import { migrate } from "./migrate.js"
import { readerOf, shadow, side } from "./shadow.js"
import type { Request } from "./shadow.js"
import { report } from "./diff.js"
import { AGREED, check } from "./gate.js"
import { cutover, router, via } from "./cutover.js"
import type { Plan, Probe } from "./cutover.js"

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const of = (id: string, versionId: number, family: string): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: moment(versionId),
  deleted: false,
  body: { resourceType: "Patient", id, name: [{ family }] }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const held: ReadonlyArray<Version> = [
  of("p1", 1, "Simpson"),
  of("p1", 2, "Terwilliger"),
  of("p2", 1, "Flanders")
]

const first: Request = { kind: "read", type: "Patient", id: "p1" }

const asked: ReadonlyArray<Request> = [
  first,
  { kind: "read", type: "Patient", id: "p2" },
  { kind: "search", type: "Patient", criteria: [["family", "Flanders"]] }
]

const withStore = async (use: (store: Versioned) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    await use(await run(versionedOn(connection)))
  } finally {
    connection.closeSync()
  }
}

const carried = (port: Incumbent, store: Versioned): Probe => ({
  name: "every version carried across",
  run: Effect.map(migrate(port, store), (found) => found.complete)
})

const agreeing = (port: Incumbent, store: Versioned): Probe => ({
  name: "no forbidden divergence",
  run: Effect.map(
    Effect.flatMap(
      shadow(side("incumbent", port), side("successor", readerOf(store)), asked),
      (found) => check(AGREED, report(found))
    ),
    (verdict) => verdict.pass
  )
})

const stray = (store: Versioned): Probe => ({
  name: "a check that fails after traffic has moved",
  run: Effect.as(store.insertVersion(of("p9", 1, "Wiggum")), false)
})

const kit = (): { readonly source: Fake; readonly port: Incumbent } => {
  const source = fake(held)
  return { source, port: sealed(source) }
}

describe("cutover and rollback", () => {
  it("moves traffic when the checks before and after both hold", async () => {
    await withStore(async (store) => {
      const { port } = kit()
      const move = router("origin")
      const plan: Plan = { before: [carried(port, store)], after: [agreeing(port, store)] }
      const found = await run(cutover(move, plan))
      expect(found.before.map((one) => one.pass)).toEqual([true])
      expect(found.moved).toBe(true)
      expect(found.after.map((one) => one.pass)).toEqual([true])
      expect(found.rolledBack).toBe(false)
      expect(found.serving).toBe("target")
      expect(found.moves).toEqual(["target"])
      const answered = await run(
        via(move, side("incumbent", port), side("successor", readerOf(store)))(first)
      )
      expect(answered).toMatchObject({ of: "resource" })
    })
  })

  it("does not move traffic when a check before the move fails", async () => {
    await withStore(async (store) => {
      const { port } = kit()
      const move = router("origin")
      const refusing: Probe = { name: "counts reconciled", run: Effect.succeed(false) }
      const found = await run(cutover(move, { before: [refusing, carried(port, store)], after: [] }))
      expect(found.before.map((one) => one.name)).toEqual(["counts reconciled"])
      expect(found.moved).toBe(false)
      expect(found.rolledBack).toBe(false)
      expect(found.serving).toBe("origin")
      expect(found.moves).toEqual([])
      expect(await run(store.current("Patient", "p1"))).toBeUndefined()
    })
  })

  it("rolls back with the data intact and serves from the original side", async () => {
    await withStore(async (store) => {
      const { source, port } = kit()
      const before = await run(survey(port))
      const move = router("origin")
      const plan: Plan = {
        before: [carried(port, store)],
        after: [agreeing(port, store), stray(store)]
      }
      const found = await run(cutover(move, plan))
      expect(found.moved).toBe(true)
      expect(found.after.map((one) => one.pass)).toEqual([true, false])
      expect(found.rolledBack).toBe(true)
      expect(found.serving).toBe("origin")
      expect(found.moves).toEqual(["target", "origin"])
      expect(await run(survey(port))).toEqual(before)
      expect(source.all()).toHaveLength(3)
      const serve = via(move, side("incumbent", port), side("successor", readerOf(store)))
      expect(await run(serve(first))).toEqual({
        of: "resource",
        body: { resourceType: "Patient", id: "p1", name: [{ family: "Terwilliger" }] }
      })
      expect(await run(serve({ kind: "read", type: "Patient", id: "p9" }))).toMatchObject({
        of: "failure",
        tag: "NotFound"
      })
      expect((await run(store.current("Patient", "p9")))?.id).toBe("p9")
    })
  })

  it("counts a check that could not run as a check that did not hold", async () => {
    await withStore(async (store) => {
      const { port } = kit()
      const move = router("origin")
      const broken: Probe = {
        name: "dependency reachable",
        run: Effect.fail(new Unavailable({ dependency: "incumbent" }))
      }
      const found = await run(cutover(move, { before: [carried(port, store), broken], after: [] }))
      expect(found.before.map((one) => one.detail)).toEqual(["held", "refused: Unavailable"])
      expect(found.moved).toBe(false)
      expect(found.serving).toBe("origin")
    })
  })

  it("moves back and forth only when asked", async () => {
    const move = router("target")
    expect(await run(move.serving())).toBe("target")
    await run(move.point("origin"))
    await run(move.point("origin"))
    expect(await run(move.moves())).toEqual(["origin", "origin"])
    expect(await run(move.serving())).toBe("origin")
  })
})
