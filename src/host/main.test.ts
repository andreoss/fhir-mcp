import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { start } from "./main.js"

const attempt = (env: Record<string, string | undefined>) =>
  Effect.runPromiseExit(Effect.scoped(start(env)))

const reason = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    return String((exit.cause.error as { message: string }).message)
  }
  throw new Error("expected a failure")
}

describe("composition root", () => {
  it("refuses to start on a configuration it cannot accept, saying why", async () => {
    expect(reason(await attempt({ FHIR_TRANSPORT: "pigeon" }))).toContain("FHIR_TRANSPORT")
  })

  it("refuses http without an origin allow list", async () => {
    expect(reason(await attempt({ FHIR_TRANSPORT: "http" }))).toContain("FHIR_HTTP_ORIGINS")
  })

  it("refuses a transport it does not yet serve rather than pretending", async () => {
    const message = reason(await attempt({
      FHIR_TRANSPORT: "http",
      FHIR_HTTP_ORIGINS: "https://a.example"
    }))
    expect(message).toContain("http")
    expect(message).toContain("not served")
  })

  it("builds a running server over the transport it does serve", async () => {
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      const server = await Effect.runPromise(Effect.scoped(start({ FHIR_TRANSPORT: "stdio" })))
      expect(server).toBeDefined()
      await server.close()
    } finally {
      process.stdout.write = original
    }
  })
})
