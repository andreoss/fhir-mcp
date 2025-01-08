import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import { check, enforce, outcome, render, validate } from "./validate.js"

const patient = {
  resourceType: "Patient",
  id: "p1",
  active: true,
  name: [{ family: "Simpson", given: ["Homer", "Jay"] }],
  gender: "male",
  birthDate: "1956-05-12",
  telecom: [{ system: "phone", value: "555-0123" }],
  address: [{ city: "Springfield", line: ["742 Evergreen Terrace"] }]
}

const observation = {
  resourceType: "Observation",
  status: "final",
  code: { coding: [{ system: "http://example.org/cs", code: "8867-4" }] },
  subject: { reference: "Patient/p1" },
  effectiveDateTime: "2024-03-01T08:30:00Z",
  valueQuantity: { value: 72.5, unit: "beats/minute" }
}

const messages = (type: string, body: unknown) =>
  check(type, body).map(render)

const rules = (type: string, body: unknown) =>
  check(type, body).map((problem) => problem.rule)

const paths = (type: string, body: unknown) =>
  check(type, body).map((problem) => problem.path)

const refusal = <A>(exit: Exit.Exit<A, Rejected>): Rejected => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    return exit.cause.error
  }
  throw new Error("expected a refusal")
}

describe("structural validation", () => {
  it("accepts a body that matches its type", () => {
    expect(check("Patient", patient)).toEqual([])
    expect(check("Observation", observation)).toEqual([])
    expect(check("Condition", {
      resourceType: "Condition",
      subject: { reference: "Patient/p1" },
      code: { text: "asthma" },
      recordedDate: "2024-03-01"
    })).toEqual([])
    expect(check("Encounter", {
      resourceType: "Encounter",
      status: "finished",
      class: { code: "AMB" },
      period: { start: "2024-03-01T08:00:00Z" }
    })).toEqual([])
  })

  it("refuses a body whose type is not the type it was sent to", () => {
    const problems = check("Patient", observation)
    expect(problems).toHaveLength(1)
    expect(problems[0]?.rule).toBe("resource-type")
    expect(problems[0]?.path).toBe("Patient")
    expect(problems[0]?.detail).toBe("expected Patient, got Observation")
  })

  it("refuses a mismatched type before it looks at anything else", () => {
    const problems = check("Patient", {
      resourceType: "Observation",
      colour: "blue",
      gender: 7
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.rule).toBe("resource-type")
  })

  it("refuses a body carrying no type at all", () => {
    expect(rules("Patient", { gender: "male" })).toEqual(["resource-type"])
    expect(messages("Patient", { resourceType: 7 })[0])
      .toBe("Patient: resource-type: expected Patient, got no resource type")
  })

  it("refuses a body that is not an object", () => {
    expect(rules("Patient", "Patient")).toEqual(["resource-type"])
    expect(rules("Patient", null)).toEqual(["resource-type"])
    expect(rules("Patient", [patient])).toEqual(["resource-type"])
  })

  it("refuses a type it holds no definition for", () => {
    const problems = check("Sasquatch", { resourceType: "Sasquatch" })
    expect(problems[0]?.rule).toBe("unknown-resource")
    expect(problems[0]?.path).toBe("Sasquatch")
  })

  it("refuses a required element that is absent, naming its path", () => {
    expect(messages("Observation", {
      resourceType: "Observation",
      code: { text: "heart rate" }
    })).toEqual(["Observation.status: required: required element is absent"])
  })

  it("refuses a required nested element that is absent", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      communication: [{ preferred: true }]
    })).toEqual([
      "Patient.communication.language: required: required element is absent"
    ])
  })

  it("accepts an empty array where no value is required", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: [{ given: [] }]
    })).toEqual([])
    expect(rules("Observation", {
      resourceType: "Observation",
      status: "final",
      code: { text: "x" },
      performer: []
    })).toEqual([])
  })

  it("refuses an empty array where a value is required", () => {
    expect(messages("Observation", {
      resourceType: "Observation",
      status: "final",
      code: []
    })).toEqual([
      "Observation.code: required: expected at least one value"
    ])
  })

  it("refuses an array where a single value is declared", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      gender: ["male"]
    })).toEqual([
      "Patient.gender: cardinality: expected a single value"
    ])
    expect(rules("Patient", {
      resourceType: "Patient",
      managingOrganization: [{ reference: "Organization/o1" }]
    })).toEqual(["cardinality"])
  })

  it("refuses a single value where a repeating element is declared", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: { family: "Simpson" }
    })).toEqual(["Patient.name: cardinality: expected an array"])
    expect(messages("Patient", {
      resourceType: "Patient",
      name: [{ given: "Homer" }]
    })).toEqual(["Patient.name.given: cardinality: expected an array"])
  })

  it("refuses a value whose primitive shape is wrong, naming the type", () => {
    expect(messages("Patient", { resourceType: "Patient", gender: 7 }))
      .toEqual(["Patient.gender: type: expected code"])
    expect(messages("Patient", { resourceType: "Patient", active: "yes" }))
      .toEqual(["Patient.active: type: expected boolean"])
    expect(messages("Patient", { resourceType: "Patient", birthDate: "12/05" }))
      .toEqual(["Patient.birthDate: type: expected date"])
    expect(messages("Patient", { resourceType: "Patient", id: "p 1" }))
      .toEqual(["Patient.id: type: expected id"])
    expect(messages("Observation", {
      resourceType: "Observation",
      status: "final",
      code: { text: "x" },
      issued: "2024-03-01"
    })).toEqual(["Observation.issued: type: expected instant"])
    expect(messages("Observation", {
      resourceType: "Observation",
      status: "final",
      code: { text: "x" },
      valueQuantity: { value: "72.5", system: "http://a b" },
      valueInteger: 1.5
    })).toEqual([
      "Observation.valueQuantity.value: type: expected decimal",
      "Observation.valueQuantity.system: type: expected uri",
      "Observation.valueInteger: type: expected integer"
    ])
  })

  it("refuses a date that is well formed but impossible", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      birthDate: "1956-02-31"
    })).toEqual(["Patient.birthDate: type: expected date"])
    expect(rules("Patient", {
      resourceType: "Patient",
      birthDate: "1956-13-01"
    })).toEqual(["type"])
  })

  it("refuses null where a value is declared", () => {
    expect(rules("Patient", { resourceType: "Patient", gender: null }))
      .toEqual(["type"])
    expect(messages("Patient", {
      resourceType: "Patient",
      managingOrganization: null
    })).toEqual([
      "Patient.managingOrganization: type: expected an object"
    ])
  })

  it("refuses a primitive where a backbone element is declared", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: ["Simpson"]
    })).toEqual(["Patient.name: type: expected an object"])
  })

  it("refuses an element the definition does not declare", () => {
    expect(messages("Patient", { resourceType: "Patient", colour: "blue" }))
      .toEqual(["Patient.colour: unknown-element: element is not declared"])
  })

  it("refuses a typo in a nested element, naming the nesting", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: [{ familyy: "Simpson" }]
    })).toEqual([
      "Patient.name.familyy: unknown-element: element is not declared"
    ])
  })

  it("validates nested backbone elements recursively", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: [{ family: 7, period: { start: "not-a-date" } }]
    })).toEqual([
      "Patient.name.family: type: expected string",
      "Patient.name.period.start: type: expected dateTime"
    ])
    expect(messages("Encounter", {
      resourceType: "Encounter",
      status: "finished",
      class: { code: "AMB" },
      participant: [{ individual: { reference: 7 } }]
    })).toEqual([
      "Encounter.participant.individual.reference: type: expected string"
    ])
  })

  it("reports every problem in one body at once", () => {
    const problems = check("Patient", {
      resourceType: "Patient",
      gender: 7,
      colour: "blue",
      name: { family: "Simpson" },
      communication: [{ preferred: true }]
    })
    expect(problems).toHaveLength(4)
    expect(rules("Patient", {
      resourceType: "Patient",
      gender: 7,
      colour: "blue",
      name: { family: "Simpson" },
      communication: [{ preferred: true }]
    }).sort()).toEqual([
      "cardinality",
      "required",
      "type",
      "unknown-element"
    ])
    for (const problem of problems) expect(problem.path).toContain("Patient.")
  })

  it("reports the same problem once however often an array repeats it", () => {
    expect(paths("Patient", {
      resourceType: "Patient",
      name: [{ family: 7 }, { family: 8 }, { family: 9 }]
    })).toEqual(["Patient.name.family"])
  })

  it("keeps a repeated element's distinct problems apart", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: [{ family: 7 }, { familyy: "Simpson" }]
    })).toEqual([
      "Patient.name.family: type: expected string",
      "Patient.name.familyy: unknown-element: element is not declared"
    ])
  })
})

describe("validation outcome", () => {
  it("says which rule failed for every problem", () => {
    const result = outcome(check("Patient", {
      resourceType: "Patient",
      gender: 7,
      colour: "blue"
    }))
    expect(result.resourceType).toBe("OperationOutcome")
    expect(result.issue).toHaveLength(2)
    for (const issue of result.issue) {
      expect(issue.severity).toBe("error")
      expect(issue.code).toBe("invalid")
    }
    expect(result.issue[0]?.diagnostics).toContain("type")
    expect(result.issue[1]?.diagnostics).toContain("unknown-element")
  })

  it("carries no value from the body it refused", () => {
    const rendered = JSON.stringify(outcome(check("Patient", {
      resourceType: "Patient",
      name: [{ family: 7, given: ["Homer"] }],
      colour: "blue"
    })))
    expect(rendered).not.toContain("Homer")
    expect(rendered).not.toContain("blue")
  })

  it("returns an outcome with no issue for a body that matches", () => {
    const result = Effect.runSync(validate("Patient", patient))
    expect(result.resourceType).toBe("OperationOutcome")
    expect(result.issue).toEqual([])
  })

  it("returns an outcome naming every problem for a body that does not", () => {
    const result = Effect.runSync(validate("Patient", {
      resourceType: "Patient",
      gender: 7,
      colour: "blue"
    }))
    expect(result.issue).toHaveLength(2)
    expect(result.issue[0]?.diagnostics)
      .toBe("Patient.gender: type: expected code")
  })

  it("writes nothing and changes nothing it was given", () => {
    const writes: Array<string> = []
    const body: Record<string, unknown> = {
      resourceType: "Patient",
      gender: 7,
      name: [{ family: "Simpson" }]
    }
    const watched = new Proxy(body, {
      set: (target, name, value) => {
        writes.push(String(name))
        return Reflect.set(target, name, value)
      },
      deleteProperty: (target, name) => {
        writes.push(String(name))
        return Reflect.deleteProperty(target, name)
      },
      defineProperty: (target, name, descriptor) => {
        writes.push(String(name))
        return Reflect.defineProperty(target, name, descriptor)
      }
    })
    const before = JSON.stringify(body)
    const first = Effect.runSync(validate("Patient", watched))
    const second = Effect.runSync(validate("Patient", watched))
    expect(writes).toEqual([])
    expect(JSON.stringify(body)).toBe(before)
    expect(second).toEqual(first)
  })

  it("validates a frozen body without touching it", () => {
    const frozen = Object.freeze({
      resourceType: "Patient",
      name: Object.freeze([Object.freeze({ family: "Simpson" })])
    })
    expect(Effect.runSync(validate("Patient", frozen)).issue).toEqual([])
  })
})

describe("refusal at the edge", () => {
  it("passes a body that matches", () => {
    expect(Effect.runSync(enforce("Patient", patient))).toBeUndefined()
  })

  it("refuses a body of the wrong type before it reaches a store", () => {
    const error = refusal(Effect.runSyncExit(enforce("Patient", observation)))
    expect(error._tag).toBe("Rejected")
    expect(error.reason)
      .toBe("Patient: resource-type: expected Patient, got Observation")
  })

  it("carries every problem into one refusal", () => {
    const error = refusal(Effect.runSyncExit(enforce("Patient", {
      resourceType: "Patient",
      gender: 7,
      colour: "blue"
    })))
    expect(error.reason).toContain("Patient.gender: type: expected code")
    expect(error.reason).toContain("Patient.colour: unknown-element")
  })

  it("renders as the outcome the rest of the stack renders", () => {
    const error = refusal(Effect.runSyncExit(enforce("Patient", observation)))
    const rendered = toOutcome(error)
    expect(rendered.issue[0]?.code).toBe("invalid")
    expect(rendered.issue[0]?.diagnostics).toContain("resource-type")
  })
})

const narrative = {
  status: "generated",
  div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">Homer Simpson</div>"
}

const served = {
  Patient: {
    resourceType: "Patient",
    id: "example",
    meta: {
      versionId: "1",
      lastUpdated: "2026-01-01T00:00:00.000Z",
      source: "urn:oid:1.2.3.4",
      profile: ["http://example.org/StructureDefinition/patient"],
      tag: [{ system: "http://example.org/tags", code: "vip" }],
      security: [{ system: "http://example.org/labels", code: "R" }]
    },
    text: narrative,
    extension: [{
      url: "http://example.org/StructureDefinition/birthPlace",
      valueAddress: { city: "Springfield" }
    }],
    identifier: [{
      use: "usual",
      type: { coding: [{ system: "http://example.org/id-types", code: "MR" }] },
      system: "urn:oid:1.2.3",
      value: "12345",
      period: { start: "2001-05-06" }
    }],
    active: true,
    name: [{ use: "official", family: "Simpson", given: ["Homer", "Jay"] }],
    telecom: [{ system: "phone", value: "555-0123", use: "home", rank: 1 }],
    gender: "male",
    birthDate: "1956-05-12",
    _birthDate: {
      extension: [{
        url: "http://example.org/StructureDefinition/precision",
        valueCode: "day"
      }]
    },
    deceasedBoolean: false,
    address: [{
      use: "home",
      line: ["742 Evergreen Terrace"],
      city: "Springfield",
      state: "NT",
      postalCode: "49007",
      country: "US"
    }],
    maritalStatus: {
      coding: [{
        system: "http://example.org/marital",
        code: "M",
        display: "Married"
      }],
      text: "Married"
    },
    communication: [{
      language: {
        coding: [{ system: "urn:ietf:bcp:47", code: "en-US" }]
      },
      preferred: true
    }],
    generalPractitioner: [{ reference: "Practitioner/1" }],
    managingOrganization: {
      reference: "Organization/1",
      display: "Springfield General"
    }
  },
  Observation: {
    resourceType: "Observation",
    id: "heart-rate",
    meta: { versionId: "3", lastUpdated: "2026-01-01T08:31:00.000Z" },
    text: narrative,
    identifier: [{ system: "urn:oid:1.2.3.5", value: "obs-1" }],
    status: "final",
    category: [{
      coding: [{
        system: "http://example.org/observation-category",
        code: "vital-signs",
        display: "Vital Signs"
      }]
    }],
    code: {
      coding: [{
        system: "http://example.org/codes",
        code: "8867-4",
        display: "Heart rate"
      }],
      text: "Heart rate"
    },
    subject: { reference: "Patient/example", display: "Homer Simpson" },
    encounter: { reference: "Encounter/example" },
    effectiveDateTime: "2026-01-01T08:30:00Z",
    issued: "2026-01-01T08:31:00.000Z",
    performer: [{ reference: "Practitioner/1" }],
    valueQuantity: {
      value: 72,
      unit: "beats/minute",
      system: "http://example.org/units",
      code: "/min"
    },
    interpretation: [{
      coding: [{ system: "http://example.org/interpretation", code: "N" }]
    }],
    note: [{ text: "taken at rest", time: "2026-01-01T08:32:00Z" }],
    method: { text: "manual palpation" },
    component: [{
      code: {
        coding: [{ system: "http://example.org/codes", code: "8480-6" }]
      },
      valueQuantity: { value: 120, unit: "mmHg" }
    }]
  },
  Condition: {
    resourceType: "Condition",
    id: "example",
    meta: { versionId: "2", lastUpdated: "2026-01-01T09:00:00.000Z" },
    text: narrative,
    identifier: [{ system: "urn:oid:1.2.3.6", value: "cond-1" }],
    clinicalStatus: {
      coding: [{
        system: "http://example.org/condition-clinical",
        code: "active"
      }]
    },
    verificationStatus: {
      coding: [{
        system: "http://example.org/condition-verification",
        code: "confirmed"
      }]
    },
    category: [{
      coding: [{
        system: "http://example.org/condition-category",
        code: "problem-list-item"
      }]
    }],
    severity: {
      coding: [{
        system: "http://example.org/codes",
        code: "24484000",
        display: "Severe"
      }]
    },
    code: {
      coding: [{
        system: "http://example.org/codes",
        code: "195967001",
        display: "Asthma"
      }],
      text: "Asthma"
    },
    bodySite: [{
      coding: [{ system: "http://example.org/codes", code: "39607008" }]
    }],
    subject: { reference: "Patient/example" },
    encounter: { reference: "Encounter/example" },
    onsetDateTime: "1964-01-01",
    recordedDate: "2026-01-01T09:00:00Z",
    recorder: { reference: "Practitioner/1" },
    asserter: { reference: "Practitioner/1" },
    note: [{ text: "diagnosed in childhood" }]
  },
  Encounter: {
    resourceType: "Encounter",
    id: "example",
    meta: { versionId: "1", lastUpdated: "2026-01-01T09:05:00.000Z" },
    text: narrative,
    identifier: [{ system: "urn:oid:1.2.3.7", value: "enc-1" }],
    status: "finished",
    class: {
      system: "http://example.org/act-code",
      code: "AMB",
      display: "ambulatory"
    },
    type: [{
      coding: [{
        system: "http://example.org/codes",
        code: "162673000",
        display: "General examination"
      }]
    }],
    priority: {
      coding: [{ system: "http://example.org/priority", code: "R" }]
    },
    subject: { reference: "Patient/example", display: "Homer Simpson" },
    participant: [{
      type: [{
        coding: [{
          system: "http://example.org/participant-type",
          code: "ATND"
        }]
      }],
      period: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T09:00:00Z" },
      individual: { reference: "Practitioner/1" }
    }],
    period: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T09:00:00Z" },
    length: {
      value: 60,
      unit: "min",
      system: "http://example.org/units",
      code: "min"
    },
    reasonCode: [{
      coding: [{ system: "http://example.org/codes", code: "25064002" }]
    }],
    diagnosis: [{
      condition: { reference: "Condition/example" },
      use: {
        coding: [{ system: "http://example.org/diagnosis-role", code: "AD" }]
      },
      rank: 1
    }],
    hospitalization: {
      admitSource: {
        coding: [{ system: "http://example.org/admit-source", code: "emd" }]
      },
      dischargeDisposition: {
        coding: [{ system: "http://example.org/discharge", code: "home" }]
      }
    },
    location: [{
      location: { reference: "Location/1" },
      status: "active",
      period: { start: "2026-01-01T08:00:00Z" }
    }],
    serviceProvider: { reference: "Organization/1" },
    partOf: { reference: "Encounter/parent" }
  }
}

describe("a body a server would send", () => {
  it("accepts a whole resource of every type it defines", () => {
    for (const [type, body] of Object.entries(served)) {
      expect(messages(type, body)).toEqual([])
    }
  })

  it("accepts the narrative every served resource carries", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      text: narrative
    })).toEqual([])
  })

  it("refuses a narrative that is missing a part of itself", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      text: { status: "generated" }
    })).toEqual(["Patient.text.div: required: required element is absent"])
    expect(rules("Patient", {
      resourceType: "Patient",
      text: { status: 7, div: "<div/>" }
    })).toEqual(["type"])
  })

  it("holds arbitrary content without walking into it", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      contained: [{
        resourceType: "Organization",
        id: "o1",
        whateverTheProfileAdded: { deep: [1, 2, { deeper: true }] }
      }],
      extension: [{
        url: "http://example.org/StructureDefinition/x",
        extension: [{ url: "nested", valueInteger: 1 }]
      }],
      modifierExtension: [{ url: "http://example.org/m", valueBoolean: true }]
    })).toEqual([])
  })

  it("carries an extension beside a nested element", () => {
    expect(messages("Patient", {
      resourceType: "Patient",
      name: [{
        id: "n1",
        family: "Simpson",
        extension: [{ url: "http://example.org/x", valueString: "y" }]
      }]
    })).toEqual([])
  })

  it("still refuses a typo in a body that otherwise looks served", () => {
    expect(messages("Patient", {
      ...served.Patient,
      birthdat: "1956-05-12"
    })).toEqual(["Patient.birthdat: unknown-element: element is not declared"])
    expect(messages("Patient", {
      ...served.Patient,
      nam: [{ family: "Simpson" }]
    })).toEqual(["Patient.nam: unknown-element: element is not declared"])
    expect(messages("Observation", {
      ...served.Observation,
      efective: "2026-01-01T08:30:00Z"
    })).toEqual([
      "Observation.efective: unknown-element: element is not declared"
    ])
  })

  it("still refuses a typo shadowing a declared primitive", () => {
    expect(rules("Patient", {
      resourceType: "Patient",
      _birthdat: { extension: [] }
    })).toEqual(["unknown-element"])
  })
})
