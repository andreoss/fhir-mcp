import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { Failure } from "../core/outcome.js"
import { convert, digestOfBody } from "./convert.js"
import type { Approved, Template } from "./convert.js"
import { APPROVED, PACK, templateOf } from "./templates.js"

const run = <A>(work: Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(work)

const broke = <A>(work: Effect.Effect<A, Failure>) =>
  Effect.runPromiseExit(work).then((result) => {
    if (Exit.isFailure(result) && result.cause._tag === "Fail") {
      return result.cause.error
    }
    throw new Error("expected a failure")
  })

const DEMOGRAPHICS = "PID|p-1|Simpson|Homer|M|1988-04-19"

const template = (id: string): Template => {
  const found = templateOf(PACK, id)
  if (found === undefined) throw new Error(`no template ${id}`)
  return found
}

const outsider: Template = {
  id: "outsider-v1",
  body: JSON.stringify({
    id: { at: 1 },
    name: [{ family: { at: 2 } }]
  })
}

const approvedOutsider: Approved = {
  id: outsider.id,
  target: "Patient",
  digest: digestOfBody(outsider.body)
}

describe("convert data", () => {
  it("converts with a template the registry approves", () =>
    run(
      Effect.map(
        convert(APPROVED, PACK, {
          template: "demographics-v1",
          input: DEMOGRAPHICS
        }),
        (built) => {
          expect(built).toEqual({
            resourceType: "Patient",
            id: "p-1",
            name: [{ family: "Simpson", given: ["Homer"] }],
            gender: "male",
            birthDate: "1988-04-19"
          })
        }
      )
    ))

  it("refuses a well-formed template the registry does not name",
    async () => {
      const failure = await broke(
        convert(APPROVED, [...PACK, outsider], {
          template: outsider.id,
          input: DEMOGRAPHICS
        })
      )
      expect(failure._tag).toBe("Forbidden")
      expect((failure as { action: string }).action).toContain(outsider.id)
    })

  it("runs the same template once the registry names it", () =>
    run(
      Effect.map(
        convert([...APPROVED, approvedOutsider], [...PACK, outsider], {
          template: outsider.id,
          input: DEMOGRAPHICS
        }),
        (built) => {
          expect(built).toEqual({
            resourceType: "Patient",
            id: "p-1",
            name: [{ family: "Simpson" }]
          })
        }
      )
    ))

  it("refuses an approved id whose body was altered", async () => {
    const held = template("demographics-v1")
    const altered: Template = {
      id: held.id,
      body: held.body.replace(`"at":2`, `"at":3`)
    }
    const failure = await broke(
      convert(APPROVED, [altered], {
        template: altered.id,
        input: DEMOGRAPHICS
      })
    )
    expect(failure._tag).toBe("Forbidden")
    expect((failure as { action: string }).action).toContain("altered")
  })

  it("refuses a template nothing offers", async () => {
    const failure = await broke(
      convert(APPROVED, PACK, { template: "absent-v1", input: DEMOGRAPHICS })
    )
    expect(failure._tag).toBe("Rejected")
  })

  it("refuses a template body that is not a mapping", async () => {
    const broken: Template = { id: "broken-v1", body: "{" }
    const failure = await broke(
      convert(
        [
          {
            id: broken.id,
            target: "Patient",
            digest: digestOfBody(broken.body)
          }
        ],
        [broken],
        { template: broken.id, input: DEMOGRAPHICS }
      )
    )
    expect(failure._tag).toBe("Rejected")
  })

  it("refuses a template body that maps to nothing", async () => {
    const empty: Template = { id: "empty-v1", body: "[]" }
    const failure = await broke(
      convert(
        [{ id: empty.id, target: "Patient", digest: digestOfBody(empty.body) }],
        [empty],
        { template: empty.id, input: DEMOGRAPHICS }
      )
    )
    expect(failure._tag).toBe("Rejected")
  })

  it("validates the output before it returns it", async () => {
    const failure = await broke(
      convert(APPROVED, PACK, {
        template: "demographics-v1",
        input: "PID|p-1|Simpson|Homer|M|yesterday"
      })
    )
    expect(failure._tag).toBe("Rejected")
    expect((failure as { reason: string }).reason).toContain("birthDate")
  })

  it("refuses output whose type the registry does not define", async () => {
    const held = template("demographics-v1")
    const failure = await broke(
      convert(
        [{ id: held.id, target: "Sighting", digest: digestOfBody(held.body) }],
        PACK,
        { template: held.id, input: DEMOGRAPHICS }
      )
    )
    expect(failure._tag).toBe("Rejected")
  })

  it("leaves absent input fields out of the output", () =>
    run(
      Effect.map(
        convert(APPROVED, PACK, {
          template: "demographics-v1",
          input: "PID|p-2"
        }),
        (built) => {
          expect(built).toEqual({ resourceType: "Patient", id: "p-2" })
        }
      )
    ))

  it("keeps an unmapped code as it stands", () =>
    run(
      Effect.map(
        convert(APPROVED, PACK, {
          template: "demographics-v1",
          input: "PID|p-3|Simpson|Homer|other"
        }),
        (built) => {
          expect(built["gender"]).toBe("other")
        }
      )
    ))

  it("converts with a second template from the same pack", () =>
    run(
      Effect.map(
        convert(APPROVED, PACK, {
          template: "contact-v1",
          input: "PID|p-4|PH|555-0100"
        }),
        (built) => {
          expect(built).toEqual({
            resourceType: "Patient",
            id: "p-4",
            telecom: [
              { system: "phone", value: "555-0100", use: "home" }
            ]
          })
        }
      )
    ))

  it("holds the approved set as data, not as code", () => {
    expect(APPROVED.every((entry) => entry.digest.length === 64)).toBe(true)
    expect(
      APPROVED.map((entry) => entry.id).includes("demographics-v1")
    ).toBe(true)
    for (const entry of APPROVED) {
      const held = templateOf(PACK, entry.id)
      expect(held === undefined || digestOfBody(held.body) === entry.digest)
        .toBe(true)
    }
  })
})
