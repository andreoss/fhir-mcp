import { describe, expect, it } from "vitest"
import { Effect, Exit, Fiber, Option } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { ensure } from "../store/query.js"
import { engineOn } from "../store/store.js"
import { fold, permits, seed } from "./model.js"
import type { Definition } from "./model.js"
import { registryOn } from "./registry.js"
import type { Registry } from "./registry.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const tag = <A, E>(result: Exit.Exit<A, E>): string => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return (result.cause.error as { readonly _tag: string })._tag
  }
  throw new Error("expected a failure")
}

const NICK: Definition = {
  type: "Patient",
  name: "nickname",
  valueType: "token",
  path: ["name", "text"],
  targets: [],
  components: []
}

const ask = async (
  connection: DuckDBConnection,
  sql: string,
  values: ReadonlyArray<unknown> = []
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const reader = await connection.runAndReadAll(sql, [...values] as never)
  return reader.getRowObjects() as ReadonlyArray<Record<string, unknown>>
}

interface Pair {
  readonly one: Registry
  readonly two: Registry
  readonly left: DuckDBConnection
  readonly right: DuckDBConnection
}

const pair = async (): Promise<Pair> => {
  const instance = await DuckDBInstance.create(":memory:")
  const left = await instance.connect()
  const right = await instance.connect()
  await run(engineOn(left))
  await run(ensure(left))
  const one = await run(registryOn(left))
  const two = await run(registryOn(right))
  return { one, two, left, right }
}

const token = (connection: DuckDBConnection, name: string, code: string) =>
  ask(
    connection,
    `insert into index_token
       (surrogate_id, resource_type, name, system, code, text)
     values (1, 'Patient', ?, null, ?, ?)`,
    [name, code, code]
  )

describe("parameter model", () => {
  it("folds a path and a value type into one seeded definition", () => {
    const found = seed()
    const family = found.find((one) => one.type === "Patient" && one.name === "family")
    expect(family?.path).toEqual(["name", "family"])
    expect(family?.valueType).toBe("string")
    const birth = found.find((one) => one.name === "birthdate")
    expect(birth?.valueType).toBe("date")
    const id = found.find((one) => one.type === "Observation" && one.name === "_id")
    expect(id?.valueType).toBe("token")
  })

  it("carries the reference targets of a declared parameter", () => {
    const found = seed()
    const subject = found.find(
      (one) => one.type === "Observation" && one.name === "subject"
    )
    expect(subject?.valueType).toBe("reference")
    expect(subject?.targets).toContain("Patient")
  })

  it("falls back to a plain parameter where no shape is declared", () => {
    expect(fold("Patient", { odd: { path: ["odd"] } }, {})).toEqual([
      {
        type: "Patient",
        name: "odd",
        valueType: "string",
        path: ["odd"],
        targets: [],
        components: []
      }
    ])
  })

  it("permits only the declared transitions", () => {
    expect(permits("draft", "backfilling")).toBe(true)
    expect(permits("draft", "active")).toBe(false)
    expect(permits("backfilling", "active")).toBe(true)
    expect(permits("retired", "active")).toBe(false)
  })
})

describe("runtime registry", () => {
  it("installs every declared parameter as an active entry", async () => {
    const db = await pair()
    await run(db.one.install)
    const all = await run(db.two.all)
    const family = all.find((one) => one.definition.name === "family")
    expect(family?.status).toBe("active")
    expect(family?.version).toBe(1)
    expect(all.length).toBe(seed().length)
  })

  it("installs once and leaves a revised entry alone", async () => {
    const db = await pair()
    await run(db.one.install)
    await run(db.one.advance({ type: "Patient", name: "family", status: "retired", version: 1 }))
    await run(db.one.install)
    const found = await run(db.one.find("Patient", "family"))
    expect(found.status).toBe("retired")
    expect(found.version).toBe(2)
  })

  it("creates a parameter as a draft with an empty index", async () => {
    const db = await pair()
    const made = await run(db.one.create(NICK))
    expect(made.status).toBe("draft")
    expect(made.version).toBe(1)
    expect(made.total).toBe(0)
    expect(await run(db.two.indexed("Patient", "nickname"))).toBe(0)
  })

  it("refuses a parameter on an unknown resource type", async () => {
    const db = await pair()
    expect(tag(await exit(db.one.create({ ...NICK, type: "Nonesuch" })))).toBe("Rejected")
  })

  it("refuses a composite parameter it cannot index", async () => {
    const db = await pair()
    expect(tag(await exit(db.one.create({ ...NICK, valueType: "composite" })))).toBe(
      "Rejected"
    )
  })

  it("refuses a parameter with no path and no name", async () => {
    const db = await pair()
    expect(tag(await exit(db.one.create({ ...NICK, path: [] })))).toBe("Rejected")
    expect(tag(await exit(db.one.create({ ...NICK, name: " " })))).toBe("Rejected")
  })

  it("reports a duplicate parameter as a conflict", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    expect(tag(await exit(db.one.create(NICK)))).toBe("Conflict")
  })

  it("leaves the live index intact when a create is refused", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await token(db.left, "nickname", "bess")
    await run(
      db.one.record({
        type: "Patient",
        name: "nickname",
        version: 1,
        done: 1,
        total: 1,
        faults: []
      })
    )
    expect(tag(await exit(db.one.create(NICK)))).toBe("Conflict")
    expect(await run(db.two.indexed("Patient", "nickname"))).toBe(1)
    const found = await run(db.two.find("Patient", "nickname"))
    expect(found.done).toBe(1)
  })

  it("clears the index when a parameter is revised", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await token(db.left, "nickname", "bess")
    const revised = await run(db.one.revise({ ...NICK, path: ["name", "given"] }, 1))
    expect(revised.version).toBe(2)
    expect(revised.status).toBe("draft")
    expect(revised.definition.path).toEqual(["name", "given"])
    expect(await run(db.two.indexed("Patient", "nickname"))).toBe(0)
  })

  it("refuses a revision that carries a stale version", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    expect(tag(await exit(db.one.revise(NICK, 7)))).toBe("Conflict")
  })

  it("reports a revision of an unknown parameter as not found", async () => {
    const db = await pair()
    expect(tag(await exit(db.one.revise(NICK, 1)))).toBe("NotFound")
    expect(tag(await exit(db.one.find("Patient", "nickname")))).toBe("NotFound")
    expect(tag(await exit(db.one.remove("Patient", "nickname", 1)))).toBe("NotFound")
  })

  it("removes the entry, its index and its faults together", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await token(db.left, "nickname", "bess")
    await run(
      db.one.record({
        type: "Patient",
        name: "nickname",
        version: 1,
        done: 1,
        total: 1,
        faults: [{ id: "p1", reason: "no value" }]
      })
    )
    await run(db.one.remove("Patient", "nickname", 1))
    expect(tag(await exit(db.two.find("Patient", "nickname")))).toBe("NotFound")
    expect(await run(db.two.indexed("Patient", "nickname"))).toBe(0)
    expect(await run(db.two.faults("Patient", "nickname"))).toEqual([])
  })

  it("refuses a removal that carries a stale version", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    expect(tag(await exit(db.one.remove("Patient", "nickname", 4)))).toBe("Conflict")
  })

  it("never lets a reader see the entry and its index disagree", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await token(db.left, "nickname", "bess")
    await token(db.left, "nickname", "liz")
    const seen = await run(
      Effect.gen(function* () {
        const writer = yield* Effect.fork(db.one.remove("Patient", "nickname", 1))
        const out: Array<{ readonly held: boolean; readonly rows: number; readonly live: boolean }> = []
        for (let round = 0; round < 40; round++) {
          const live = Option.isNone(yield* Fiber.poll(writer))
          const held = yield* db.two.view("Patient", "nickname")
          out.push({ held: held.entry !== undefined, rows: held.rows, live })
          yield* Effect.yieldNow()
        }
        yield* Fiber.join(writer)
        return out
      })
    )
    expect(seen.some((one) => one.live)).toBe(true)
    expect(seen.every((one) => one.held === (one.rows > 0))).toBe(true)
    expect(seen.some((one) => !one.held)).toBe(true)
  })

  it("refuses a transition the model does not declare", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    expect(
      tag(
        await exit(
          db.one.advance({ type: "Patient", name: "nickname", status: "active", version: 1 })
        )
      )
    ).toBe("Rejected")
  })

  it("refuses activation while the backfill is short of the total", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await run(
      db.one.advance({ type: "Patient", name: "nickname", status: "backfilling", version: 1 })
    )
    await run(
      db.one.record({
        type: "Patient",
        name: "nickname",
        version: 2,
        done: 1,
        total: 3,
        faults: []
      })
    )
    expect(
      tag(
        await exit(
          db.one.advance({ type: "Patient", name: "nickname", status: "active", version: 2 })
        )
      )
    ).toBe("Conflict")
  })

  it("activates once the backfill covers every resource", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await run(
      db.one.advance({ type: "Patient", name: "nickname", status: "backfilling", version: 1 })
    )
    await run(
      db.one.record({
        type: "Patient",
        name: "nickname",
        version: 2,
        done: 3,
        total: 3,
        faults: []
      })
    )
    const active = await run(
      db.one.advance({ type: "Patient", name: "nickname", status: "active", version: 2 })
    )
    expect(active.status).toBe("active")
    expect(active.done).toBe(3)
  })

  it("keeps a fault per resource rather than one for the run", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    await run(
      db.one.record({
        type: "Patient",
        name: "nickname",
        version: 1,
        done: 2,
        total: 2,
        faults: [
          { id: "p1", reason: "not a date" },
          { id: "p2", reason: "not a date" }
        ]
      })
    )
    const found = await run(db.two.faults("Patient", "nickname"))
    expect(found.map((one) => one.id)).toEqual(["p1", "p2"])
    expect((await run(db.two.find("Patient", "nickname"))).failures).toBe(2)
  })

  it("refuses progress that carries a stale version", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    expect(
      tag(
        await exit(
          db.one.record({
            type: "Patient",
            name: "nickname",
            version: 9,
            done: 1,
            total: 1,
            faults: []
          })
        )
      )
    ).toBe("Conflict")
  })

  it("advances the epoch on a change and holds it on progress", async () => {
    const db = await pair()
    const before = await run(db.two.epoch)
    await run(db.one.create(NICK))
    const made = await run(db.two.epoch)
    expect(made).toBeGreaterThan(before)
    await run(
      db.one.record({
        type: "Patient",
        name: "nickname",
        version: 1,
        done: 1,
        total: 1,
        faults: []
      })
    )
    expect(await run(db.two.epoch)).toBe(made)
    await run(db.one.remove("Patient", "nickname", 1))
    expect(await run(db.two.epoch)).toBeGreaterThan(made)
  })

  it("tells the loser when two updates race on one connection", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    const attempt = (path: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const before = yield* db.one.find("Patient", "nickname")
        yield* Effect.yieldNow()
        return yield* Effect.exit(db.one.revise({ ...NICK, path }, before.version))
      })
    const [left, right] = await run(
      Effect.all([attempt(["name", "given"]), attempt(["name", "prefix"])], {
        concurrency: "unbounded"
      })
    )
    const won = [left, right].filter(Exit.isSuccess)
    const lost = [left, right].filter(Exit.isFailure)
    expect(won.length).toBe(1)
    expect(lost.length).toBe(1)
    expect(tag(lost[0]!)).toBe("Conflict")
    expect((await run(db.one.find("Patient", "nickname"))).version).toBe(2)
  })

  it("tells the loser when two instances race on the same parameter", async () => {
    const db = await pair()
    await run(db.one.create(NICK))
    const attempt = (registry: Registry, path: ReadonlyArray<string>, gate: Effect.Latch) =>
      Effect.gen(function* () {
        const before = yield* registry.find("Patient", "nickname")
        yield* gate.await
        return yield* Effect.exit(registry.revise({ ...NICK, path }, before.version))
      })
    const [left, right] = await run(
      Effect.gen(function* () {
        const gate = yield* Effect.makeLatch()
        const a = yield* Effect.fork(attempt(db.one, ["name", "given"], gate))
        const b = yield* Effect.fork(attempt(db.two, ["name", "prefix"], gate))
        yield* gate.open
        return [yield* Fiber.join(a), yield* Fiber.join(b)] as const
      })
    )
    expect([left, right].filter(Exit.isSuccess).length).toBe(1)
    expect(tag([left, right].filter(Exit.isFailure)[0]!)).toBe("Conflict")
    const settled = await run(db.one.find("Patient", "nickname"))
    expect(settled.version).toBe(2)
    expect(await run(db.two.indexed("Patient", "nickname"))).toBe(0)
  })
})

describe("registry faults", () => {
  it("reports the store as unavailable when it cannot be reached", async () => {
    const db = await pair()
    db.left.closeSync()
    expect(tag(await exit(db.one.find("Patient", "family")))).toBe("Unavailable")
  })
})
