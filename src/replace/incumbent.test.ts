import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { READS, sealed } from "./incumbent.js"
import type { Incumbent, Writable } from "./incumbent.js"
import { fake } from "./fake.js"
import type { Version } from "../core/interactions.js"

const moment = (n: number): string => new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString()

const entry = (id: string, versionId: number, family: string): Version => ({
  type: "Patient",
  id,
  versionId,
  lastUpdated: moment(versionId),
  deleted: false,
  body: { resourceType: "Patient", id, name: [{ family }] }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const tag = async <A, E>(effect: Effect.Effect<A, E>): Promise<string> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const seeded = () => fake([entry("p1", 1, "Simpson"), entry("p2", 1, "Flanders")])

describe("incumbent port", () => {
  it("exposes the read members and nothing else", () => {
    const port = sealed(seeded())
    expect(Reflect.ownKeys(port)).toEqual([...READS])
    expect(Object.keys(port)).toEqual([...READS])
    expect("insert" in port).toBe(false)
    expect("read" in port).toBe(true)
  })

  it("reads schema, types, records and search state", async () => {
    const port = sealed(seeded())
    const schema = await run(port.schema())
    const types = await run(port.types())
    const records = await run(port.records("Patient"))
    const state = await run(port.searchState())
    expect(schema.table.map((one) => one.name)).toContain("record")
    expect(types).toEqual(["Patient"])
    expect(records).toHaveLength(2)
    expect(state.some((one) => one.name === "family")).toBe(true)
  })

  it("refuses a write attempted through the port", async () => {
    const source = seeded()
    const port = sealed(source)
    const attempt = (port as unknown as Writable).insert(entry("p3", 1, "Van Houten"))
    expect(await tag(attempt)).toBe("Forbidden")
    expect(source.all()).toHaveLength(2)
    expect(source.log()).toEqual([])
  })

  it("refuses a delete attempted through the port", async () => {
    const source = seeded()
    const port = sealed(source)
    expect(await tag((port as unknown as Writable).drop("Patient", "p1"))).toBe("Forbidden")
    expect(source.all()).toHaveLength(2)
    expect(source.log()).toEqual([])
  })

  it("refuses assignment and removal of a port member", () => {
    const source = seeded()
    const port = sealed(source) as unknown as Record<string, unknown>
    expect(() => {
      port["records"] = () => Effect.succeed([])
    }).toThrow()
    expect(() => {
      delete port["read"]
    }).toThrow()
    expect(() => {
      Object.defineProperty(port, "insert", { value: 1 })
    }).toThrow()
    expect(source.all()).toHaveLength(2)
  })

  it("hands back records that cannot be written into", async () => {
    const port = sealed(seeded())
    const records = await run(port.records("Patient"))
    const first = records[0]
    expect(first).toBeDefined()
    expect(() => {
      ;(first as unknown as { id: string }).id = "other"
    }).toThrow()
    expect(() => {
      ;(records as Array<Version>).push(entry("p9", 1, "Wiggum"))
    }).toThrow()
  })

  it("refuses a member that is not a read", async () => {
    const port = sealed({ ...seeded(), records: 3 } as unknown as Incumbent)
    expect(await tag(port.records("Patient"))).toBe("Forbidden")
  })

  it("is not thenable", () => {
    const port = sealed(seeded()) as unknown as Record<string, unknown>
    expect(port["then"]).toBeUndefined()
    expect(port[Symbol.toStringTag as unknown as string]).toBeUndefined()
  })
})

describe("incumbent stand-in", () => {
  it("reports the current version and skips older ones", async () => {
    const source = fake([entry("p1", 1, "Simpson"), entry("p1", 2, "Terwilliger")])
    const found = await run(source.read("Patient", "p1"))
    expect(found?.versionId).toBe(2)
    expect(await run(source.read("Patient", "gone"))).toBeUndefined()
  })

  it("matches on a declared parameter and refuses an undeclared one", async () => {
    const source = seeded()
    const found = await run(source.matching("Patient", [["family", "Simpson"]]))
    expect(found.map((one) => one.id)).toEqual(["p1"])
    expect(await tag(source.matching("Patient", [["nose", "big"]]))).toBe("Rejected")
    expect(await tag(source.matching("Practitioner", []))).toBe("Unavailable")
  })

  it("records the writes it is asked for directly", async () => {
    const source = seeded()
    await run(source.insert(entry("p3", 1, "Van Houten")))
    expect(source.all()).toHaveLength(3)
    await run(source.drop("Patient", "p3"))
    expect(source.all()).toHaveLength(2)
    expect(source.log()).toEqual(["insert Patient/p3", "drop Patient/p3"])
  })

  it("reports a parameter that is not ready", async () => {
    const source = fake([entry("p1", 1, "Simpson")], ["given"])
    const state = await run(source.searchState())
    expect(state.find((one) => one.name === "given")?.ready).toBe(false)
    expect(state.find((one) => one.name === "family")?.ready).toBe(true)
  })
})
