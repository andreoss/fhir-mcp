import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { FhirEngine } from "../core/engine.js"
import type { Engine } from "../core/engine.js"
import { NotFound } from "../core/outcome.js"
import { serveOverStdio } from "./server.js"

const engine: Layer.Layer<FhirEngine> = Layer.succeed(FhirEngine, {
  read: (type, id) => Effect.fail(new NotFound({ type, id })),
  search: () => Effect.succeed({ resourceType: "Bundle", type: "searchset", entry: [] }),
  resourceTypes: () => Effect.succeed([]),
  searchParameters: () => Effect.succeed([])
} satisfies Engine)

describe("stdio transport", () => {
  it("connects and writes nothing to the answer stream before it is asked", async () => {
    const written: Array<string> = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const server = await Effect.runPromise(serveOverStdio(engine))
      expect(written).toEqual([])
      await server.close()
    } finally {
      process.stdout.write = original
    }
  })

  it("reports a transport that refuses rather than throwing past the caller", async () => {
    const original = process.stdin.on.bind(process.stdin)
    process.stdin.on = (() => {
      throw new Error("stream refused")
    }) as typeof process.stdin.on
    try {
      const exit = await Effect.runPromiseExit(serveOverStdio(engine))
      expect(exit._tag).toBe("Failure")
    } finally {
      process.stdin.on = original
    }
  })
})
