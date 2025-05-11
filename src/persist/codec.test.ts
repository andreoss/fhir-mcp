import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import type { FhirResource } from "../core/engine.js"
import type { Failure } from "../core/outcome.js"
import { decode, encode, lazy, measure, pack, unpack } from "./codec.js"

const run = <A>(work: Effect.Effect<A, Failure>): Promise<A> =>
  Effect.runPromise(work)

const failed = <A>(result: Exit.Exit<A, Failure>): Failure => {
  if (Exit.isFailure(result) && result.cause._tag === "Fail") {
    return result.cause.error
  }
  throw new Error("expected a failure")
}

const narrative = (times: number) =>
  Array.from(
    { length: times },
    (_, at) => `<p>Observation ${at} recorded by the attending clinician.</p>`
  ).join("")

const patient: FhirResource = {
  resourceType: "Patient",
  id: "p-1",
  meta: { versionId: "3", lastUpdated: "2024-01-01T00:00:00.000Z" },
  identifier: [
    { system: "urn:oid:1.2.36.146.595.217.0.1", value: "12345" },
    { system: "http://example.org/mrn", value: "MRN-99812" }
  ],
  active: true,
  name: [
    { use: "official", family: "Sorensen", given: ["Asa", "Marie"] },
    { use: "usual", given: ["Asa"] }
  ],
  telecom: [
    { system: "phone", value: "+31 20 555 0100", use: "home" },
    { system: "email", value: "asa@example.org" }
  ],
  gender: "female",
  birthDate: "1974-12-25",
  address: [
    {
      use: "home",
      line: ["Keizersgracht 123", "Second floor"],
      city: "Amsterdam",
      postalCode: "1015 CJ",
      country: "NL"
    }
  ],
  communication: [
    { language: { coding: [{ system: "urn:ietf:bcp:47", code: "nl" }] } }
  ]
}

const observation: FhirResource = {
  resourceType: "Observation",
  id: "o-1",
  status: "final",
  category: [
    {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          code: "vital-signs",
          display: "Vital Signs"
        }
      ]
    }
  ],
  code: {
    coding: [
      { system: "http://loinc.org", code: "85354-9", display: "Blood pressure" }
    ]
  },
  subject: { reference: "Patient/p-1" },
  effectiveDateTime: "2024-03-04T09:30:00.000Z",
  text: { status: "generated", div: `<div>${narrative(40)}</div>` },
  component: Array.from({ length: 12 }, (_, at) => ({
    code: { coding: [{ system: "http://loinc.org", code: `8480-${at}` }] },
    valueQuantity: {
      value: 120 + at,
      unit: "mmHg",
      system: "http://unitsofmeasure.org",
      code: "mm[Hg]"
    }
  }))
}

const awkward: FhirResource = {
  resourceType: "Condition",
  id: "c-1",
  note: [{ text: 'linea — 中文 — slash \\ and "quoted"' }],
  extension: [
    { url: "http://example.org/x", valueDecimal: 0.30000000000000004 }
  ],
  onsetPeriod: { start: "2020-01-01", end: null },
  emptyList: [],
  nested: { a: { b: { c: { d: [1, 2, 3, { e: true }] } } } }
}

const corpus: ReadonlyArray<readonly [string, FhirResource]> = [
  ["patient", patient],
  ["observation", observation],
  ["awkward", awkward]
]

describe("compressed storage", () => {
  it.each(corpus)("round-trips %s without loss", (_name, body) =>
    run(
      Effect.gen(function* () {
        const bytes = yield* pack(body)
        const back = yield* unpack(bytes)
        expect(back).toEqual(body)
        expect(JSON.stringify(back)).toBe(JSON.stringify(body))
      })
    ))

  it.each(corpus)("stores %s in fewer bytes than the raw body", (_name, body) =>
    run(
      Effect.gen(function* () {
        const sizes = yield* measure(body)
        expect(sizes.raw).toBe(Buffer.byteLength(JSON.stringify(body)))
        expect(sizes.packed).toBeLessThan(sizes.raw)
      })
    ))

  it("stores the corpus in under half the raw bytes", () =>
    run(
      Effect.gen(function* () {
        const sizes = yield* Effect.forEach(corpus, ([, body]) => measure(body))
        const raw = sizes.reduce((total, one) => total + one.raw, 0)
        const packed = sizes.reduce((total, one) => total + one.packed, 0)
        expect(packed / raw).toBeLessThan(0.5)
      })
    ))

  it("survives a trip through a text column", () =>
    run(
      Effect.gen(function* () {
        const text = encode(yield* pack(observation))
        expect(text).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
        expect(yield* unpack(decode(text))).toEqual(observation)
      })
    ))

  it("does not parse the body until it is asked for", () =>
    run(
      Effect.gen(function* () {
        const held = lazy(yield* pack(patient))
        expect(held.parsed()).toBe(false)
        expect(held.bytes).toBeGreaterThan(0)
        expect(yield* held.body).toEqual(patient)
        expect(held.parsed()).toBe(true)
      })
    ))

  it("parses once and reuses what it parsed", () =>
    run(
      Effect.gen(function* () {
        const held = lazy(yield* pack(observation))
        const first = yield* held.body
        const second = yield* held.body
        expect(second).toBe(first)
      })
    ))

  it("refuses bytes that are not a stored body", async () => {
    const junk = Uint8Array.from([1, 2, 3, 4])
    expect(failed(await Effect.runPromiseExit(unpack(junk)))._tag).toBe(
      "Rejected"
    )
    const held = lazy(junk)
    expect(failed(await Effect.runPromiseExit(held.body))._tag).toBe("Rejected")
    expect(held.parsed()).toBe(false)
  })
})
