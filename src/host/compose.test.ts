import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Grant } from "../agent/write.js"
import { grantOf, journalToErrors, wiring } from "./compose.js"
import type { Config } from "../config/config.js"

const config = (allowWrite: boolean): Config => ({
  transport: "stdio",
  http: { host: "127.0.0.1", port: 8080, origins: [] },
  store: { path: ":memory:" },
  scopes: [],
  allowWrite,
  terminologyDir: undefined,
  logLevel: "info"
})

const grantIn = (allowWrite: boolean) =>
  Effect.runSync(Effect.provide(Grant, grantOf(config(allowWrite), "c1")))

describe("composition", () => {
  it("withholds the write capability unless the configuration grants it", () => {
    expect(grantIn(false).write).toBe(false)
  })

  it("passes the write capability through when the configuration grants it", () => {
    expect(grantIn(true).write).toBe(true)
  })

  it("carries a correlation id into the grant", () => {
    expect(grantIn(false).correlation).toBe("c1")
  })

  it("never puts a token in the grant it was not given", () => {
    expect(grantIn(true).token).toBeUndefined()
  })

  it("writes an audit entry to the error stream, never the answer stream", async () => {
    const written: Array<string> = []
    const original = process.stderr.write.bind(process.stderr)
    const answer: Array<string> = []
    const stdout = process.stdout.write.bind(process.stdout)
    process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true }) as never
    process.stdout.write = ((chunk: string) => { answer.push(String(chunk)); return true }) as never
    try {
      await Effect.runPromise(
        Effect.flatMap(Effect.provide(
          Effect.gen(function* () {
            const { Journal } = yield* Effect.promise(() => import("../agent/write.js"))
            return yield* Journal
          }),
          journalToErrors
        ), (ledger) => ledger.note({ at: "t", correlation: "c1", actor: "anonymous", tool: "create", outcome: "success" }))
      )
    } finally {
      process.stderr.write = original
      process.stdout.write = stdout
    }
    expect(written.join("")).toContain("create")
    expect(answer).toEqual([])
  })

  it("builds every layer the surface requires", async () => {
    const built = await Effect.runPromise(
      Effect.scoped(Layer.build(Layer.orDie(wiring(config(false)))))
    )
    expect(built).toBeDefined()
  })
})
