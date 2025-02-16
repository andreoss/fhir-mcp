import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { statement } from "../conformance/capability.js"
import { REGISTRIES } from "../conformance/versions.js"
import { surface } from "../protocol/server.js"
import { checksOf, verify } from "./checks.js"
import type { Observed, Verdict } from "./checks.js"
import { defaultSuite, loadSuite, unmet } from "./external.js"
import type { Suite } from "./external.js"
import { open } from "./harness.js"
import type { Session } from "./harness.js"
import { load, pathOf, regressions, save } from "./record.js"
import type { Conformance } from "./record.js"

const DIR = fileURLToPath(new URL("record/", import.meta.url))

const registry = REGISTRIES[0]

const asked = (called: unknown): Record<string, unknown> =>
  called as Record<string, unknown>

const gather = async (session: Session): Promise<Observed> => {
  const listed = await session.listTools()
  const all = await session.callTool("capabilities", {})
  if (all.kind !== "answered") throw new Error("capabilities was refused")
  const types = asked(all.body)["resourceTypes"] as ReadonlyArray<string>
  const params: Record<string, ReadonlyArray<string>> = {}
  for (const type of types) {
    const one = await session.callTool("capabilities", { type })
    if (one.kind !== "answered") throw new Error(`capabilities was refused for ${type}`)
    params[type] = asked(one.body)["parameters"] as ReadonlyArray<string>
  }
  return { tools: listed.map((tool) => tool.name), types, params }
}

describe("conformance recorded per version", () => {
  let session: Session
  let seen: Observed
  let verdicts: ReadonlyArray<Verdict>
  let suite: Suite
  let missing: ReadonlyArray<string>
  let now: Conformance

  beforeAll(async () => {
    if (registry === undefined) throw new Error("no registry")
    session = await open({ write: true })
    seen = await gather(session)
    const declared = statement(
      {
        software: asked(session.greeting["serverInfo"]) as unknown as {
          name: string
          version: string
        },
        date: "recorded"
      },
      registry,
      surface(true)
    )
    verdicts = verify(checksOf(declared), seen)
    suite = await Effect.runPromise(loadSuite(defaultSuite()))
    missing = unmet(suite, verdicts)
    now = {
      revision: String(session.greeting["protocolVersion"]),
      fhirVersion: registry.fhirVersion,
      software: asked(session.greeting["serverInfo"]) as unknown as {
        name: string
        version: string
      },
      checks: verdicts,
      unmet: missing
    }
  }, 120000)

  afterAll(async () => {
    await session.close()
  })

  it("derives a check for every interaction, type and parameter declared", () => {
    expect(verdicts.length).toBeGreaterThan(20)
    expect(verdicts.map((one) => one.id)).toContain("interaction:create")
    expect(verdicts.map((one) => one.id)).toContain("param:Patient.family")
  })

  it("serves everything the capability statement of this build declares", () => {
    expect(verdicts.filter((one) => !one.met).map((one) => one.id)).toEqual([])
  })

  it("names the external expectations this build does not meet", () => {
    expect(missing).toContain("interaction:vread")
    expect(missing).toContain("system:transaction")
    expect(missing).toContain("type:Practitioner")
    expect(missing).toContain("param:Patient.name")
    expect(missing).not.toContain("interaction:read")
    expect(missing).not.toContain("param:Patient.family")
    expect(suite.version).toBe(registry?.fhirVersion)
  })

  it("records the run and blocks a regression against the last one", async () => {
    const path = pathOf(DIR, now.fhirVersion)
    const before = await Effect.runPromise(load(path))
    const lost = regressions(before, now)
    expect(lost).toEqual([])
    await Effect.runPromise(save(path, now))
    const again = await Effect.runPromise(load(path))
    expect(again?.checks).toEqual(
      [...now.checks].sort((a, b) => a.id.localeCompare(b.id))
    )
    expect(again?.revision).toBe("2025-03-26")
  })
})
