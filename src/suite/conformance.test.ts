import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { statement } from "../conformance/capability.js"
import { REGISTRIES } from "../conformance/versions.js"
import type { Registry } from "../conformance/versions.js"
import { surface } from "../protocol/server.js"
import { checksOf, verify } from "./checks.js"
import type { Observed, Verdict } from "./checks.js"
import { defaultSuite, loadSuite, unmet } from "./external.js"
import type { Suite } from "./external.js"
import { drive, stepsOf } from "./exercise.js"
import type { Concept, Step } from "./exercise.js"
import { termsEntry } from "./build.js"
import { open } from "./harness.js"
import type { Session } from "./harness.js"
import { load, pathOf, regressions, save } from "./record.js"
import type { Conformance } from "./record.js"

const DIR = fileURLToPath(new URL("record/", import.meta.url))

const OFFERED = surface(true, true, true)

const NAMES = OFFERED.map((tool) => tool.name)

const TERMS: Concept = {
  system: "http://loinc.org",
  code: "1234-5",
  display: "Glucose [Mass/volume] in Serum"
}

const asked = (called: unknown): Record<string, unknown> =>
  called as Record<string, unknown>

const loaded = async (concept: Concept): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "fhir-suite-terms-"))
  await writeFile(
    join(dir, "system.json"),
    `${JSON.stringify({
      resourceType: "CodeSystem",
      url: concept.system,
      version: "2.74",
      content: "complete",
      concept: [{ code: concept.code, display: concept.display }]
    })}\n`,
    "utf8"
  )
  return dir
}

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

const run = (session: Session, steps: ReadonlyArray<Step>): Promise<ReadonlyArray<string>> =>
  drive(steps, session.callTool)

describe("conformance recorded per version", () => {
  let written: Session
  let reading: Session
  let seen: Observed
  let suite: Suite
  let software: { readonly name: string; readonly version: string }

  beforeAll(async () => {
    const terms = await loaded(TERMS)
    const env = { FHIR_TERMINOLOGY_DIR: terms }
    written = await open({ entry: termsEntry(), write: true, env })
    reading = await open({ entry: termsEntry(), write: false, env })
    seen = await gather(written)
    suite = await Effect.runPromise(loadSuite(defaultSuite()))
    software = asked(written.greeting["serverInfo"]) as unknown as {
      name: string
      version: string
    }
  }, 180000)

  afterAll(async () => {
    await written.close()
    await reading.close()
  })

  const declaredOf = (registry: Registry) =>
    statement({ software, date: "recorded" }, registry, OFFERED)

  const verdictsOf = (registry: Registry): ReadonlyArray<Verdict> =>
    verify(checksOf(declaredOf(registry), NAMES), seen)

  for (const registry of REGISTRIES) {
    describe(`the surface a ${registry.fhirVersion} build declares`, () => {
      it("derives a check for every interaction, type, parameter and tool declared", () => {
        const verdicts = verdictsOf(registry)
        expect(verdicts.length).toBeGreaterThan(20)
        expect(verdicts.map((one) => one.id)).toContain("interaction:create")
        expect(verdicts.map((one) => one.id)).toContain("param:Patient.family")
        expect(verdicts.map((one) => one.id)).toContain("tool:lookup")
      })

      it("serves everything the capability statement of this build declares", () => {
        expect(verdictsOf(registry).filter((one) => !one.met).map((one) => one.id)).toEqual([])
      })

      it("names the external expectations this build does not meet", () => {
        const missing = unmet(suite, verdictsOf(registry))
        expect(missing).toContain("interaction:vread")
        expect(missing).toContain("system:transaction")
        expect(missing).toContain("type:Practitioner")
        expect(missing).toContain("param:Patient.name")
        expect(missing).not.toContain("interaction:read")
        expect(missing).not.toContain("param:Patient.family")
        expect(suite.version).toBe(registry.fhirVersion)
      })

      it("exercises every tool it serves against a real server", async () => {
        const steps = stepsOf(registry, { write: true, terms: TERMS, jobs: true })
        expect(new Set(steps.map((step) => step.tool))).toEqual(new Set(NAMES))
        expect(await run(written, steps)).toEqual([])
      })

      it("exercises every tool it serves when writing is not granted", async () => {
        const steps = stepsOf(registry, { write: false, terms: TERMS })
        expect(steps.map((step) => step.tool)).not.toContain("create")
        expect(new Set(steps.map((step) => step.tool))).toEqual(
          new Set(surface(false, true).map((tool) => tool.name))
        )
        expect(await run(reading, steps)).toEqual([])
      })

      it("records the run and blocks a regression against the last one", async () => {
        const verdicts = verdictsOf(registry)
        const now: Conformance = {
          revision: String(written.greeting["protocolVersion"]),
          fhirVersion: registry.fhirVersion,
          software,
          checks: verdicts,
          unmet: unmet(suite, verdicts)
        }
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
  }
})
