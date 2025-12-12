import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { DuckDBInstance } from "@duckdb/node-api"
import { Rules, Versions, defaults, read } from "../core/interactions.js"
import type { Entry } from "./audit.js"
import { Journal } from "./audit.js"
import { Grant } from "./write.js"
import { Unit, unitOn } from "../bundle/unit.js"
import { bundleTools, callBundle } from "./bundle.js"

const patient = (id: string): Record<string, unknown> => ({
  resourceType: "Patient",
  id,
  name: [{ family: "Simpson" }]
})

const wrote = (url: string, resource: unknown) => ({
  resource,
  request: { method: "POST", url }
})

const kept = async () => {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  const bound = await Effect.runPromise(unitOn(connection))
  const seen: Array<Entry> = []
  const live = (write: boolean) =>
    Layer.mergeAll(
      Layer.succeed(Versions, bound.store),
      Layer.succeed(Rules, defaults),
      Layer.succeed(Unit, bound.boundary),
      Layer.succeed(Grant, { write, correlation: "c1" }),
      Layer.succeed(Journal, {
        note: (entry: Entry) =>
          Effect.sync(() => {
            seen.push(entry)
          })
      })
    )
  const rows = async (): Promise<number> => {
    const reader = await connection.runAndReadAll("select count(*) as n from resource")
    return Number(reader.getRowObjects()[0]?.["n"] ?? 0)
  }
  return {
    seen,
    rows,
    run: (name: string, args: unknown, write = true) =>
      Effect.runPromise(Effect.provide(callBundle(name, args), live(write))),
    exit: (name: string, args: unknown, write = true) =>
      Effect.runPromiseExit(Effect.provide(callBundle(name, args), live(write))),
    stored: (type: string, id: string) =>
      Effect.runPromiseExit(Effect.provide(read(type, id), live(true)))
  }
}

const body = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  JSON.parse(result.content[0]?.text ?? "{}") as {
    readonly type?: string
    readonly entry?: ReadonlyArray<{ readonly response: { readonly status: string } }>
  }

const codes = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  (body(result).entry ?? []).map((one) => one.response.status)

describe("BNDL the bundle door on the write surface", () => {
  it("keeps every entry of a transaction and reads one back", async () => {
    const held = await kept()
    const answer = await held.run("transaction", {
      entry: [wrote("Patient", patient("p1")), wrote("Patient", patient("p2"))]
    })
    expect(answer.isError).toBe(false)
    expect(body(answer).type).toBe("transaction-response")
    expect(codes(answer)).toEqual(["201", "201"])
    expect(await held.rows()).toBe(2)
    expect(Exit.isSuccess(await held.stored("Patient", "p1"))).toBe(true)
  })

  it("keeps nothing when one entry of a transaction fails", async () => {
    const held = await kept()
    const answer = await held.run("transaction", {
      entry: [wrote("Patient", patient("p1")), { request: { method: "POST", url: "Patient" } }]
    })
    expect(answer.isError).toBe(true)
    expect(await held.rows()).toBe(0)
    expect(Exit.isFailure(await held.stored("Patient", "p1"))).toBe(true)
  })

  it("answers one outcome per entry of a batch", async () => {
    const held = await kept()
    const answer = await held.run("batch", {
      entry: [
        wrote("Patient", patient("p1")),
        { request: { method: "POST", url: "not an interaction" } }
      ]
    })
    expect(answer.isError).toBe(false)
    expect(body(answer).type).toBe("batch-response")
    expect(codes(answer)).toEqual(["201", "400"])
    expect(await held.rows()).toBe(1)
  })

  it("refuses a write entry when the grant is read-only", async () => {
    const held = await kept()
    const answer = await held.run("batch", { entry: [wrote("Patient", patient("p1"))] }, false)
    expect(codes(answer)).toEqual(["403"])
    expect(await held.rows()).toBe(0)
  })

  it("refuses a tool it does not carry", async () => {
    const held = await kept()
    const answer = await held.run("bundle", { entry: [] })
    expect(answer.isError).toBe(true)
    expect(answer.content[0]?.text).toContain("unknown tool: bundle")
  })

  it("refuses a call with no entry list", async () => {
    const held = await kept()
    const answer = await held.run("transaction", {})
    expect(answer.isError).toBe(true)
    expect(answer.content[0]?.text).toContain("entry")
  })

  it("journals the tool and the outcome of the call", async () => {
    const held = await kept()
    await held.run("transaction", { entry: [wrote("Patient", patient("p1"))] })
    expect(held.seen.map((one) => [one.tool, one.outcome])).toEqual([["transaction", "success"]])
    await held.run("batch", {}, false)
    expect(held.seen.map((one) => one.outcome)).toEqual(["success", "refused"])
  })

  it("offers a transaction and a batch that are not read-only", async () => {
    expect(bundleTools.map((tool) => tool.name)).toEqual(["transaction", "batch"])
    for (const tool of bundleTools) {
      expect(tool.annotations.readOnlyHint).toBe(false)
      expect(tool.annotations.destructiveHint).toBe(true)
      expect(tool.inputSchema.required).toEqual(["entry"])
    }
  })

  it("reads back what a transaction wrote and only that", async () => {
    const held = await kept()
    await held.run("transaction", { entry: [wrote("Patient", patient("p1"))] })
    expect(Exit.isSuccess(await held.stored("Patient", "p1"))).toBe(true)
    expect(Exit.isFailure(await held.stored("Patient", "p2"))).toBe(true)
  })
})
