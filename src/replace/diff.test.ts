import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { versionedOn } from "../store/versioned.js"
import type { Versioned } from "../store/versioned.js"
import type { Version } from "../core/interactions.js"
import { sealed } from "./incumbent.js"
import { fake } from "./fake.js"
import { readerOf, shadow, side } from "./shadow.js"
import type { Answer, Pair, Request, Run } from "./shadow.js"
import { KINDS, compare, report } from "./diff.js"
import type { Kind } from "./diff.js"

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const of = (id: string, family: string): Version => ({
  type: "Patient",
  id,
  versionId: 1,
  lastUpdated: moment(1),
  deleted: false,
  body: { resourceType: "Patient", id, name: [{ family }] }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const asking: Request = { kind: "read", type: "Patient", id: "p1" }

const pair = (left: Answer, right: Answer): Pair => ({ request: asking, left, right })

const one = (id: string, family: string): Answer => ({
  of: "resource",
  body: { resourceType: "Patient", id, name: [{ family }] }
})

const set = (total: number, id: ReadonlyArray<string>): Answer => ({ of: "set", total, id })

const gone: Answer = { of: "failure", tag: "NotFound", detail: "Patient/p1 not found" }

const running = (found: ReadonlyArray<Pair>): Run => ({
  left: "incumbent",
  right: "successor",
  pair: found
})

const kinds = (found: ReadonlyArray<{ readonly kind: Kind }>): ReadonlyArray<Kind> =>
  found.map((entry) => entry.kind)

const withStore = async (use: (store: Versioned) => Promise<void>): Promise<void> => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    await use(await run(versionedOn(connection)))
  } finally {
    connection.closeSync()
  }
}

describe("divergence classification", () => {
  it("finds nothing when the two answers agree", () => {
    expect(compare("incumbent", "successor", pair(one("p1", "Simpson"), one("p1", "Simpson"))))
      .toEqual([])
    expect(compare("incumbent", "successor", pair(set(1, ["p1"]), set(1, ["p1"])))).toEqual([])
    expect(compare("incumbent", "successor", pair(gone, gone))).toEqual([])
  })

  it("classifies a resource present on one side only", () => {
    const left = compare("incumbent", "successor", pair(one("p1", "Simpson"), gone))
    expect(left).toEqual([
      {
        kind: "only-left",
        severity: "critical",
        request: asking,
        detail: "answered on incumbent, refused on successor"
      }
    ])
    expect(kinds(compare("incumbent", "successor", pair(gone, one("p1", "Simpson"))))).toEqual([
      "only-right"
    ])
  })

  it("classifies a differing field value without carrying the value", () => {
    const found = compare(
      "incumbent",
      "successor",
      pair(one("p1", "Simpson"), one("p1", "Terwilliger"))
    )
    expect(found).toEqual([
      {
        kind: "field",
        severity: "major",
        request: asking,
        detail: "field differs at name.0.family"
      }
    ])
    expect(JSON.stringify(found)).not.toContain("Terwilliger")
  })

  it("holds a differing stamp to be minor", () => {
    const stamped = (value: string): Answer => ({
      of: "resource",
      body: { resourceType: "Patient", id: "p1", meta: { versionId: value } }
    })
    const found = compare("incumbent", "successor", pair(stamped("1"), stamped("2")))
    expect(found.map((entry) => entry.severity)).toEqual(["minor"])
    expect(found[0]?.detail).toBe("field differs at meta.versionId")
  })

  it("classifies a differing count and the ids behind it", () => {
    const found = compare("incumbent", "successor", pair(set(2, ["p1", "p2"]), set(1, ["p1"])))
    expect(kinds(found)).toEqual(["count", "only-left"])
    expect(found[0]?.detail).toBe("total is 2 on incumbent and 1 on successor")
    expect(found[1]?.detail).toBe("Patient/p2 only on incumbent")
    const other = compare("incumbent", "successor", pair(set(1, ["p1"]), set(1, ["p2"])))
    expect(kinds(other)).toEqual(["only-left", "only-right"])
  })

  it("classifies a differing failure", () => {
    const found = compare(
      "incumbent",
      "successor",
      pair(
        { of: "failure", tag: "Unavailable", detail: "index unavailable" },
        { of: "failure", tag: "Rejected", detail: "unsupported resource type: Practitioner" }
      )
    )
    expect(found).toEqual([
      {
        kind: "error",
        severity: "major",
        request: asking,
        detail: "failure is Unavailable on incumbent and Rejected on successor"
      }
    ])
  })

  it("classifies a differing answer shape", () => {
    const found = compare("incumbent", "successor", pair(one("p1", "Simpson"), set(1, ["p1"])))
    expect(found).toEqual([
      {
        kind: "error",
        severity: "critical",
        request: asking,
        detail: "answer is resource on incumbent and set on successor"
      }
    ])
  })

  it("finds a field added on one side only", () => {
    const found = compare(
      "incumbent",
      "successor",
      pair(
        { of: "resource", body: { resourceType: "Patient", id: "p1", active: true } },
        { of: "resource", body: { resourceType: "Patient", id: "p1" } }
      )
    )
    expect(found[0]?.detail).toBe("field differs at active")
  })

  it("finds a longer collection on one side", () => {
    const found = compare(
      "incumbent",
      "successor",
      pair(
        { of: "resource", body: { resourceType: "Patient", id: "p1", name: [{ family: "a" }] } },
        {
          of: "resource",
          body: {
            resourceType: "Patient",
            id: "p1",
            name: [{ family: "a" }, { family: "b" }]
          }
        }
      )
    )
    expect(found.map((entry) => entry.detail)).toEqual(["field differs at name.1"])
  })
})

describe("difference report", () => {
  it("counts every divergence by kind and by severity and keeps the request", () => {
    const found = report(
      running([
        pair(one("p1", "Simpson"), gone),
        pair(one("p1", "Simpson"), one("p1", "Terwilliger")),
        pair(set(2, ["p1", "p2"]), set(1, ["p1"])),
        pair(one("p1", "Simpson"), one("p1", "Simpson"))
      ])
    )
    expect(found.left).toBe("incumbent")
    expect(found.right).toBe("successor")
    expect(found.of).toBe(4)
    expect(found.byKind).toEqual({
      "only-left": 2,
      "only-right": 0,
      field: 1,
      count: 1,
      error: 0
    })
    expect(found.bySeverity).toEqual({ critical: 2, major: 2, minor: 0 })
    expect(found.divergence.every((entry) => entry.request === asking)).toBe(true)
    expect(KINDS).toEqual(["only-left", "only-right", "field", "count", "error"])
  })

  it("reports a clean run as empty", () => {
    const found = report(running([pair(gone, gone)]))
    expect(found.divergence).toEqual([])
    expect(found.bySeverity).toEqual({ critical: 0, major: 0, minor: 0 })
  })

  it("reports the divergences of a real run against the stand-in", async () => {
    await withStore(async (store) => {
      await run(store.insertVersion(of("p1", "Terwilliger")))
      await run(store.insertVersion(of("p3", "Simpson")))
      const source = fake([of("p1", "Simpson"), of("p2", "Simpson"), of("p3", "Simpson")])
      const request: ReadonlyArray<Request> = [
        { kind: "read", type: "Patient", id: "p1" },
        { kind: "read", type: "Patient", id: "p2" },
        { kind: "search", type: "Patient", criteria: [["family", "Simpson"]] },
        { kind: "search", type: "Practitioner", criteria: [] }
      ]
      const found = report(
        await run(
          shadow(side("incumbent", sealed(source)), side("successor", readerOf(store)), request)
        )
      )
      expect(found.byKind).toEqual({
        "only-left": 3,
        "only-right": 0,
        field: 1,
        count: 1,
        error: 1
      })
      const counted = found.divergence.find((entry) => entry.kind === "count")
      expect(counted?.request).toEqual(request[2])
    })
  })
})
