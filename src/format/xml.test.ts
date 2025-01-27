import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { types } from "../model/resources.js"
import { check } from "../model/validate.js"
import { el, group } from "../model/shape.js"
import type { Definition } from "../model/shape.js"
import { FHIR } from "./defs.js"
import { XHTML } from "./narrative.js"
import { parse, serialize } from "./xml.js"

const run = <A>(effect: Effect.Effect<A, Failure>): A => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a value: ${JSON.stringify(exit.cause)}`)
}

const failed = (effect: Effect.Effect<unknown, Failure>): Failure => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    return exit.cause.error
  }
  throw new Error("expected a refusal")
}

const bad = (effect: Effect.Effect<unknown, Failure>): string => {
  const error = failed(effect)
  if (error instanceof Rejected) return error.reason
  throw new Error("expected a rejection")
}

type Body = Record<string, unknown>

const div = (inner: string): string =>
  `<div xmlns="${XHTML}">${inner}</div>`

const patientOne: Body = {
  resourceType: "Patient",
  id: "pat-1",
  meta: {
    versionId: "3",
    lastUpdated: "2024-01-02T03:04:05Z",
    source: "http://example.org/feed",
    profile: ["http://example.org/StructureDefinition/p"],
    tag: [{ system: "http://example.org/tags", code: "reviewed" }]
  },
  language: "en",
  text: { status: "generated", div: div("<p>Ada Lovelace</p>") },
  identifier: [
    { use: "usual", system: "http://example.org/mrn", value: "12345" },
    { use: "secondary", system: "http://example.org/nhs", value: "999" }
  ],
  active: true,
  name: [
    { use: "official", family: "Lovelace", given: ["Augusta", "Ada"] },
    { use: "nickname", given: ["Ada"] }
  ],
  telecom: [
    { system: "phone", value: "+44 20 7946 0000", use: "home", rank: 1 },
    { system: "email", value: "ada@example.org", rank: 2 }
  ],
  gender: "female",
  birthDate: "1815-12-10",
  deceasedBoolean: true,
  address: [
    {
      use: "home",
      line: ["12 Ockham Road", "Flat 3"],
      city: "London",
      postalCode: "NW1 1AA",
      country: "GB"
    }
  ],
  maritalStatus: {
    coding: [
      { system: "http://example.org/ms", code: "M", display: "Married" }
    ],
    text: "Married"
  },
  multipleBirthInteger: 2,
  communication: [
    {
      language: { coding: [{ system: "urn:ietf:bcp:47", code: "en" }] },
      preferred: true
    }
  ],
  generalPractitioner: [
    { reference: "Practitioner/gp-1", display: "Dr Byron" }
  ],
  managingOrganization: { reference: "Organization/org-1" }
}

const patientTwo: Body = {
  resourceType: "Patient",
  id: "pat-2",
  extension: [
    {
      url: "http://example.org/race",
      valueCoding: {
        system: "http://example.org/cs",
        code: "2106-3",
        display: "White"
      }
    },
    {
      id: "nested",
      url: "http://example.org/group",
      extension: [
        { url: "http://example.org/group#a", valueString: "left" },
        { url: "http://example.org/group#b", valueDecimal: 1.5 }
      ]
    }
  ],
  name: [
    {
      id: "n1",
      family: "Hopper",
      given: ["Grace", "Brewster"],
      _given: [
        null,
        {
          id: "g2",
          extension: [
            { url: "http://example.org/middle", valueBoolean: true }
          ]
        }
      ]
    }
  ],
  gender: "female",
  birthDate: "1906-12-09",
  _birthDate: {
    id: "bd",
    extension: [
      {
        url: "http://hl7.org/fhir/StructureDefinition/patient-birthTime",
        valueDateTime: "1906-12-09T05:30:00Z"
      }
    ]
  }
}

const patientThree: Body = {
  resourceType: "Patient",
  contained: [
    {
      resourceType: "Observation",
      id: "obs-x",
      status: "final",
      code: { text: "Weight" },
      valueQuantity: { value: 70, unit: "kg", code: "kg" }
    },
    {
      resourceType: "Condition",
      id: "cond-x",
      subject: { reference: "#" },
      code: { text: "Diabetes" }
    }
  ],
  name: [{ text: "Anonymous" }],
  _birthDate: {
    extension: [
      { url: "http://example.org/absent", valueCode: "unknown" }
    ]
  }
}

const patientFour: Body = {
  resourceType: "Patient",
  text: {
    status: "additional",
    div: div(
      "<table><tr><td>Name</td><td>A &amp; B</td></tr>" +
        "<tr><td>Note</td><td>1 &lt; 2</td></tr></table>" +
        '<p class="small"><b>bold</b> and <i>italic</i></p><hr/>'
    )
  },
  active: false,
  name: [{ family: "O&#39;Neill" }],
  telecom: [{ system: "url", value: "http://example.org/a?x=1&amp;y=2" }]
}

const observationOne: Body = {
  resourceType: "Observation",
  id: "obs-1",
  meta: { versionId: "1", lastUpdated: "2024-03-01T10:00:00Z" },
  text: { status: "generated", div: div("<p>Body weight 72.5 kg</p>") },
  identifier: [{ system: "http://example.org/obs", value: "o-1" }],
  status: "final",
  category: [
    { coding: [{ system: "http://example.org/cat", code: "vital-signs" }] }
  ],
  code: {
    coding: [
      {
        system: "http://loinc.org",
        code: "29463-7",
        display: "Body weight",
        userSelected: false
      }
    ],
    text: "Weight"
  },
  subject: { reference: "Patient/pat-1" },
  encounter: { reference: "Encounter/enc-1" },
  effectiveDateTime: "2024-03-01T09:45:00Z",
  issued: "2024-03-01T10:00:00Z",
  performer: [{ reference: "Practitioner/gp-1" }],
  valueQuantity: {
    value: 72.5,
    unit: "kg",
    system: "http://unitsofmeasure.org",
    code: "kg"
  },
  interpretation: [{ coding: [{ code: "N" }] }],
  note: [
    { text: "Measured after breakfast", time: "2024-03-01T10:01:00Z" },
    { text: "Scale calibrated" }
  ],
  bodySite: { text: "whole body" },
  method: { text: "scale" },
  hasMember: [{ reference: "Observation/obs-2" }],
  derivedFrom: [{ reference: "Observation/obs-0" }]
}

const observationTwo: Body = {
  resourceType: "Observation",
  id: "obs-2",
  status: "amended",
  code: { text: "Blood pressure" },
  subject: { reference: "Patient/pat-1" },
  effectivePeriod: {
    start: "2024-03-01T09:00:00Z",
    end: "2024-03-01T09:05:00Z"
  },
  dataAbsentReason: { text: "not performed" },
  component: [
    {
      code: { text: "Systolic" },
      valueQuantity: { value: 120, unit: "mmHg", code: "mm[Hg]" }
    },
    {
      code: { text: "Diastolic" },
      valueQuantity: { value: 80, unit: "mmHg", code: "mm[Hg]" },
      interpretation: [{ text: "low" }]
    }
  ]
}

const observationThree: Body = {
  resourceType: "Observation",
  id: "obs-3",
  status: "preliminary",
  code: { text: "Free text finding" },
  valueString: "no abnormality detected",
  note: [{ text: "typed by hand" }]
}

const observationFour: Body = {
  resourceType: "Observation",
  id: "obs-4",
  status: "registered",
  code: { text: "Counts" },
  valueInteger: -12
}

const conditionOne: Body = {
  resourceType: "Condition",
  id: "cond-1",
  clinicalStatus: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: "active"
      }
    ]
  },
  verificationStatus: { coding: [{ code: "confirmed" }] },
  category: [{ text: "Problem list item" }],
  severity: { text: "Moderate" },
  code: {
    coding: [
      {
        system: "http://snomed.info/sct",
        code: "44054006",
        display: "Diabetes mellitus type 2"
      }
    ]
  },
  bodySite: [{ text: "Pancreas" }],
  subject: { reference: "Patient/pat-1" },
  encounter: { reference: "Encounter/enc-1" },
  onsetDateTime: "2019-04-01",
  recordedDate: "2019-04-02",
  recorder: { reference: "Practitioner/gp-1" },
  asserter: { reference: "Practitioner/gp-1" },
  note: [{ text: "Diet controlled" }, { text: "Reviewed in 2024" }]
}

const conditionTwo: Body = {
  resourceType: "Condition",
  id: "cond-2",
  subject: { reference: "Patient/pat-2" },
  onsetString: "in childhood",
  abatementDateTime: "2001-06",
  code: { text: "Asthma" }
}

const encounterOne: Body = {
  resourceType: "Encounter",
  id: "enc-1",
  status: "finished",
  class: {
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    code: "AMB",
    display: "ambulatory"
  },
  type: [{ text: "Consultation" }],
  serviceType: { text: "General practice" },
  priority: { text: "Routine" },
  subject: { reference: "Patient/pat-1" },
  participant: [
    {
      type: [{ text: "Primary performer" }],
      period: { start: "2024-03-01T09:00:00Z" },
      individual: { reference: "Practitioner/gp-1" }
    },
    { individual: { reference: "Practitioner/gp-2" } }
  ],
  period: {
    start: "2024-03-01T09:00:00Z",
    end: "2024-03-01T09:30:00Z"
  },
  length: {
    value: 30,
    unit: "min",
    system: "http://unitsofmeasure.org",
    code: "min"
  },
  reasonCode: [{ text: "Annual review" }],
  reasonReference: [{ reference: "Condition/cond-1" }],
  diagnosis: [
    {
      condition: { reference: "Condition/cond-1" },
      use: { text: "Discharge diagnosis" },
      rank: 1
    }
  ],
  hospitalization: {
    admitSource: { text: "Referral" },
    dischargeDisposition: { text: "Home" }
  },
  location: [
    {
      location: { reference: "Location/loc-1" },
      status: "completed",
      period: { start: "2024-03-01T09:00:00Z" }
    }
  ],
  serviceProvider: { reference: "Organization/org-1" },
  partOf: { reference: "Encounter/enc-0" }
}

const bundleOne: Body = {
  resourceType: "Bundle",
  id: "bundle-1",
  meta: { lastUpdated: "2024-03-02T00:00:00Z" },
  type: "searchset",
  timestamp: "2024-03-02T00:00:00Z",
  total: 2,
  link: [
    { relation: "self", url: "http://example.org/Patient?name=lovelace" },
    { relation: "next", url: "http://example.org/Patient?page=2" }
  ],
  entry: [
    {
      fullUrl: "http://example.org/Patient/pat-1",
      resource: patientOne,
      search: { mode: "match", score: 0.75 }
    },
    {
      fullUrl: "http://example.org/Observation/obs-1",
      resource: observationOne,
      search: { mode: "include" }
    }
  ]
}

const bundleTwo: Body = {
  resourceType: "Bundle",
  id: "bundle-2",
  type: "transaction",
  entry: [
    {
      fullUrl: "urn:uuid:0f2c-1",
      resource: conditionTwo,
      request: {
        method: "POST",
        url: "Condition",
        ifNoneExist: "identifier=http://example.org|1"
      }
    },
    {
      fullUrl: "urn:uuid:0f2c-2",
      resource: encounterOne,
      request: { method: "PUT", url: "Encounter/enc-1", ifMatch: "W/\"3\"" },
      response: {
        status: "200 OK",
        location: "Encounter/enc-1/_history/4",
        etag: "W/\"4\"",
        lastModified: "2024-03-02T00:00:01Z"
      }
    }
  ]
}

const outcomeBody: Body = {
  resourceType: "OperationOutcome",
  text: { status: "generated", div: div("<p>One issue</p>") },
  issue: [
    {
      severity: "error",
      code: "invalid",
      details: { text: "the body is not a Patient" },
      diagnostics: "Patient.birthDate: expected date",
      expression: ["Patient.birthDate"]
    },
    { severity: "error", code: "not-found", diagnostics: "Patient/x not found" }
  ]
}

const BODIES: ReadonlyArray<Body> = [
  patientOne,
  patientTwo,
  patientThree,
  patientFour,
  observationOne,
  observationTwo,
  observationThree,
  observationFour,
  conditionOne,
  conditionTwo,
  encounterOne,
  bundleOne,
  bundleTwo,
  outcomeBody
]

const named = (body: Body, index: number): string =>
  `${String(body["resourceType"])}#${String(body["id"] ?? index)}`

describe("round trip", () => {
  BODIES.forEach((body, index) => {
    it(`carries ${named(body, index)} from object to xml and back`, () => {
      expect(run(parse(run(serialize(body))))).toEqual(body)
    })

    it(`carries ${named(body, index)} from xml to object and back`, () => {
      const document = run(serialize(body))
      expect(run(serialize(run(parse(document))))).toBe(document)
    })
  })

  it("covers every declared resource type and the bundle", () => {
    const covered = new Set(BODIES.map((body) => body["resourceType"]))
    for (const type of types()) expect(covered.has(type)).toBe(true)
    expect(covered.has("Bundle")).toBe(true)
    expect(covered.has("OperationOutcome")).toBe(true)
  })

  it("uses bodies the model already accepts", () => {
    for (const body of BODIES) {
      const type = body["resourceType"]
      if (typeof type !== "string" || !types().includes(type)) continue
      expect(check(type, body)).toEqual([])
    }
  })

  it("keeps the order of repeated elements", () => {
    const document = run(serialize(patientOne))
    expect(document.indexOf('value="Augusta"')).toBeLessThan(
      document.indexOf('value="Ada"')
    )
    expect(document.indexOf('value="12 Ockham Road"')).toBeLessThan(
      document.indexOf('value="Flat 3"')
    )
    expect(document.indexOf('value="12345"')).toBeLessThan(
      document.indexOf('value="999"')
    )
  })

  it("keeps the order of repeated groups", () => {
    const back = run(parse(run(serialize(observationTwo))))
    const held = back["component"] as ReadonlyArray<Record<string, unknown>>
    expect((held[0]?.["code"] as Body)["text"]).toBe("Systolic")
    expect((held[1]?.["code"] as Body)["text"]).toBe("Diastolic")
  })
})

describe("element shape", () => {
  it("writes a primitive as a child element with a value attribute", () => {
    const body = { resourceType: "Patient", birthDate: "1956-05-12" }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12"/></Patient>`
    )
  })

  it("reads a primitive from the value attribute", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12"/></Patient>`
    expect(run(parse(document))).toEqual({
      resourceType: "Patient",
      birthDate: "1956-05-12"
    })
  })

  it("names the root element for the type and carries the namespace", () => {
    const document = run(serialize({ resourceType: "Condition" }))
    expect(document).toBe(`<Condition xmlns="${FHIR}"/>`)
  })

  it("repeats a sibling element for each entry of an array", () => {
    const body = {
      resourceType: "Patient",
      name: [{ given: ["A", "B"] }]
    }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><name><given value="A"/>` +
        `<given value="B"/></name></Patient>`
    )
  })

  it("carries the id of a nested element as an attribute", () => {
    const body = { resourceType: "Patient", name: [{ id: "n1" }] }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><name id="n1"/></Patient>`
    )
  })

  it("carries the id of a resource as a child element", () => {
    const body = { resourceType: "Patient", id: "p1" }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><id value="p1"/></Patient>`
    )
  })

  it("writes booleans, integers and decimals as text", () => {
    const body = {
      resourceType: "Patient",
      active: true,
      multipleBirthInteger: 3
    }
    expect(run(serialize(body))).toContain('<active value="true"/>')
    expect(run(serialize(body))).toContain('<multipleBirthInteger value="3"/>')
  })

  it("reads booleans, integers and decimals back as values", () => {
    const document =
      `<Observation xmlns="${FHIR}"><status value="final"/>` +
      `<code><text value="x"/></code>` +
      `<valueQuantity><value value="72.5"/></valueQuantity></Observation>`
    const back = run(parse(document))
    const quantity = back["valueQuantity"] as Body
    expect(quantity["value"]).toBe(72.5)
  })

  it("escapes and unescapes reserved characters in attributes", () => {
    const body = {
      resourceType: "Patient",
      name: [{ text: 'A & B < C > D "quoted"' }]
    }
    const document = run(serialize(body))
    expect(document).toContain("&amp;")
    expect(document).toContain("&lt;")
    expect(document).toContain("&quot;")
    expect(run(parse(document))).toEqual(body)
  })

  it("ignores whitespace and comments between elements", () => {
    const document =
      `<Patient xmlns="${FHIR}">\n  <!-- a note -->\n` +
      `  <birthDate value="1956-05-12"/>\n</Patient>\n`
    expect(run(parse(document))).toEqual({
      resourceType: "Patient",
      birthDate: "1956-05-12"
    })
  })

  it("accepts a leading xml declaration", () => {
    const document =
      `<?xml version="1.0" encoding="UTF-8"?><Patient xmlns="${FHIR}"/>`
    expect(run(parse(document))).toEqual({ resourceType: "Patient" })
  })

  it("carries a contained resource inside its wrapper element", () => {
    const body = {
      resourceType: "Patient",
      contained: [{ resourceType: "Condition", id: "c1" }]
    }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><contained><Condition>` +
        `<id value="c1"/></Condition></contained></Patient>`
    )
  })

  it("carries a bundle entry resource inside its wrapper element", () => {
    const body = {
      resourceType: "Bundle",
      type: "collection",
      entry: [{ resource: { resourceType: "Patient", id: "p1" } }]
    }
    expect(run(serialize(body))).toBe(
      `<Bundle xmlns="${FHIR}"><type value="collection"/><entry>` +
        `<resource><Patient><id value="p1"/></Patient></resource>` +
        `</entry></Bundle>`
    )
  })
})

describe("narrative", () => {
  it("writes the div as markup rather than as a value", () => {
    const body = {
      resourceType: "Patient",
      text: { status: "generated", div: div("<p>Hi</p>") }
    }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><text><status value="generated"/>` +
        `<div xmlns="${XHTML}"><p>Hi</p></div></text></Patient>`
    )
  })

  it("reads the div back as a string", () => {
    const document =
      `<Patient xmlns="${FHIR}"><text><status value="generated"/>` +
      `<div xmlns="${XHTML}"><p>Hi</p></div></text></Patient>`
    const back = run(parse(document))["text"] as Body
    expect(back["div"]).toBe(div("<p>Hi</p>"))
  })

  it("keeps nested markup, attributes and entities in the div", () => {
    const inner =
      '<p class="lead">a &amp; b</p><ul><li>one</li><li>two</li></ul>'
    const body = {
      resourceType: "Patient",
      text: { status: "additional", div: div(inner) }
    }
    expect(run(parse(run(serialize(body))))).toEqual(body)
  })

  it("refuses a div without the xhtml namespace on the way in", () => {
    const document =
      `<Patient xmlns="${FHIR}"><text><status value="generated"/>` +
      `<div><p>Hi</p></div></text></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.text.div: expected the xhtml namespace"
    )
  })

  it("refuses a div without the xhtml namespace on the way out", () => {
    const body = {
      resourceType: "Patient",
      text: { status: "generated", div: "<div><p>Hi</p></div>" }
    }
    expect(bad(serialize(body))).toBe(
      "Patient.text.div: expected the xhtml namespace"
    )
  })

  it("refuses narrative that is not a div", () => {
    const body = {
      resourceType: "Patient",
      text: { status: "generated", div: `<p xmlns="${XHTML}">Hi</p>` }
    }
    expect(bad(serialize(body))).toBe(
      "Patient.text.div: expected a div element"
    )
  })

  it("refuses narrative that is not a string", () => {
    const body = { resourceType: "Patient", text: { status: "x", div: 7 } }
    expect(bad(serialize(body))).toBe("Patient.text.div: expected string")
  })

  it("refuses active content in narrative on the way out", () => {
    const body = {
      resourceType: "Patient",
      text: { status: "generated", div: div("<script>alert(1)</script>") }
    }
    expect(bad(serialize(body))).toBe(
      "Patient.text.div: <script> is not accepted in narrative"
    )
  })

  it("refuses active content in narrative on the way in", () => {
    const document =
      `<Patient xmlns="${FHIR}"><text><status value="generated"/>` +
      `<div xmlns="${XHTML}"><p><iframe src="x"/></p></div>` +
      `</text></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.text.div: <iframe> is not accepted in narrative"
    )
  })

  it("refuses an event handler attribute in narrative", () => {
    const body = {
      resourceType: "Patient",
      text: {
        status: "generated",
        div: div('<p onclick="steal()">Hi</p>')
      }
    }
    expect(bad(serialize(body))).toBe(
      'Patient.text.div: attribute "onclick" is not accepted in narrative'
    )
  })

  it("refuses a scripted link in narrative", () => {
    const body = {
      resourceType: "Patient",
      text: {
        status: "generated",
        div: div('<a href="javascript:steal()">Hi</a>')
      }
    }
    expect(bad(serialize(body))).toBe(
      'Patient.text.div: attribute "href" is not accepted in narrative'
    )
  })

  it("refuses a document type declaration inside narrative", () => {
    const body = {
      resourceType: "Patient",
      text: {
        status: "generated",
        div: `<!DOCTYPE div><div xmlns="${XHTML}"/>`
      }
    }
    expect(bad(serialize(body))).toBe(
      "Patient.text.div: a document type declaration is not accepted"
    )
  })
})

describe("primitive extensions", () => {
  it("writes the shadow object as attributes and children", () => {
    const body = {
      resourceType: "Patient",
      birthDate: "1956-05-12",
      _birthDate: {
        id: "bd",
        extension: [{ url: "http://example.org/x", valueString: "why" }]
      }
    }
    expect(run(serialize(body))).toBe(
      `<Patient xmlns="${FHIR}"><birthDate id="bd" value="1956-05-12">` +
        `<extension url="http://example.org/x">` +
        `<valueString value="why"/></extension></birthDate></Patient>`
    )
  })

  it("reads attributes and children back into the shadow object", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate id="bd" value="1956-05-12">` +
      `<extension url="http://example.org/x">` +
      `<valueString value="why"/></extension></birthDate></Patient>`
    expect(run(parse(document))).toEqual({
      resourceType: "Patient",
      birthDate: "1956-05-12",
      _birthDate: {
        id: "bd",
        extension: [{ url: "http://example.org/x", valueString: "why" }]
      }
    })
  })

  it("aligns the shadow array with the value array", () => {
    const body = {
      resourceType: "Patient",
      name: [
        {
          given: ["Grace", "Brewster"],
          _given: [null, { id: "g2" }]
        }
      ]
    }
    const document = run(serialize(body))
    expect(document).toContain('<given value="Grace"/>')
    expect(document).toContain('<given id="g2" value="Brewster"/>')
    expect(run(parse(document))).toEqual(body)
  })

  it("carries an extension with no value at all", () => {
    const body = {
      resourceType: "Patient",
      _birthDate: {
        extension: [{ url: "http://example.org/absent", valueCode: "asked" }]
      }
    }
    const document = run(serialize(body))
    expect(document).toContain("<birthDate>")
    expect(document).not.toContain('birthDate value')
    expect(run(parse(document))).toEqual(body)
  })

  it("carries a modifier extension on a primitive", () => {
    const body = {
      resourceType: "Patient",
      gender: "other",
      _gender: {
        modifierExtension: [
          { url: "http://example.org/m", valueBoolean: false }
        ]
      }
    }
    expect(run(parse(run(serialize(body))))).toEqual(body)
  })

  it("refuses a shadow that is not an object", () => {
    const body = {
      resourceType: "Patient",
      birthDate: "1956-05-12",
      _birthDate: 4
    }
    expect(bad(serialize(body))).toBe("Patient._birthDate: expected an object")
  })

  it("refuses a shadow whose keys are not element properties", () => {
    const body = {
      resourceType: "Patient",
      birthDate: "1956-05-12",
      _birthDate: { value: "1956-05-12" }
    }
    expect(bad(serialize(body))).toBe(
      "Patient._birthDate.value: element is not declared"
    )
  })

  it("refuses a shadow for an element that is not declared", () => {
    const body = { resourceType: "Patient", _nothing: { id: "x" } }
    expect(bad(serialize(body))).toBe(
      "Patient._nothing: element is not declared"
    )
  })

  it("refuses a shadow for a group", () => {
    const body = { resourceType: "Patient", _name: { id: "x" } }
    expect(bad(serialize(body))).toBe("Patient._name: element is not declared")
  })
})

describe("refusing a document that is not fhir xml", () => {
  it("refuses an attribute other than value, id and url", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12" lang="en"/>` +
      `</Patient>`
    expect(bad(parse(document))).toBe(
      'Patient.birthDate: attribute "lang" is not accepted'
    )
  })

  it("refuses an attribute on a group", () => {
    const document = `<Patient xmlns="${FHIR}"><name given="A"/></Patient>`
    expect(bad(parse(document))).toBe(
      'Patient.name[0]: attribute "given" is not accepted'
    )
  })

  it("refuses a namespace declaration below the root", () => {
    const document =
      `<Patient xmlns="${FHIR}"><name xmlns="${FHIR}"/></Patient>`
    expect(bad(parse(document))).toBe(
      'Patient.name[0]: attribute "xmlns" is not accepted'
    )
  })

  it("refuses a root without the fhir namespace", () => {
    expect(bad(parse("<Patient/>"))).toBe(
      "document: expected the fhir namespace"
    )
  })

  it("refuses a root that is not a known resource type", () => {
    expect(bad(parse(`<Widget xmlns="${FHIR}"/>`))).toBe(
      "document: unknown resource type Widget"
    )
  })

  it("refuses an element that is not declared", () => {
    const document = `<Patient xmlns="${FHIR}"><nickname value="A"/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.nickname: element is not declared"
    )
  })

  it("refuses a single element that is repeated", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12"/>` +
      `<birthDate value="1956-05-13"/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.birthDate: element does not repeat"
    )
  })

  it("refuses elements that are out of definition order", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12"/>` +
      `<gender value="female"/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.gender: elements are out of order"
    )
  })

  it("refuses repeats that are not adjacent", () => {
    const document =
      `<Patient xmlns="${FHIR}"><name><given value="A"/></name>` +
      `<gender value="female"/><name><given value="B"/></name></Patient>`
    expect(bad(parse(document))).toBe("Patient.name: elements are out of order")
  })

  it("refuses an element with neither a value nor an extension", () => {
    const document = `<Patient xmlns="${FHIR}"><birthDate/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.birthDate: an element must carry a value or an extension"
    )
  })

  it("refuses text content inside a fhir element", () => {
    const document = `<Patient xmlns="${FHIR}"><name>Ada</name></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.name[0]: text content is not accepted"
    )
  })

  it("refuses text content inside a primitive element", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12">x` +
      `</birthDate></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.birthDate: text content is not accepted"
    )
  })

  it("refuses an element child of a primitive that is not an extension", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-05-12">` +
      `<given value="A"/></birthDate></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.birthDate.given: element is not declared"
    )
  })

  it("refuses an element id written as a child element", () => {
    const document =
      `<Patient xmlns="${FHIR}"><name><id value="n1"/></name></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.name[0].id: id is carried as an attribute"
    )
  })

  it("refuses an extension with no url", () => {
    const document =
      `<Patient xmlns="${FHIR}"><extension>` +
      `<valueString value="x"/></extension></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.extension[0].url: required element is absent"
    )
  })

  it("refuses a value that does not match its declared type", () => {
    const document = `<Patient xmlns="${FHIR}"><active value="yes"/></Patient>`
    expect(bad(parse(document))).toBe("Patient.active: expected boolean")
  })

  it("refuses a date that is not a date", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="1956-13-45"/></Patient>`
    expect(bad(parse(document))).toBe("Patient.birthDate: expected date")
  })

  it("refuses an integer that is not an integer", () => {
    const document =
      `<Patient xmlns="${FHIR}"><multipleBirthInteger value="1.5"/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.multipleBirthInteger: expected integer"
    )
  })

  it("refuses a decimal that is not a number", () => {
    const document =
      `<Observation xmlns="${FHIR}"><status value="final"/>` +
      `<code><text value="x"/></code>` +
      `<valueQuantity><value value="many"/></valueQuantity></Observation>`
    expect(bad(parse(document))).toBe(
      "Observation.valueQuantity.value: expected decimal"
    )
  })

  it("refuses a container that does not hold exactly one resource", () => {
    const document = `<Patient xmlns="${FHIR}"><contained/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.contained[0]: expected one resource element"
    )
  })

  it("refuses an attribute on a container", () => {
    const document =
      `<Patient xmlns="${FHIR}"><contained id="x">` +
      `<Condition/></contained></Patient>`
    expect(bad(parse(document))).toBe(
      'Patient.contained[0]: attribute "id" is not accepted'
    )
  })

  it("refuses a contained resource of an unknown type", () => {
    const document =
      `<Patient xmlns="${FHIR}"><contained><Widget/></contained></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.contained[0]: unknown resource type Widget"
    )
  })

  it("names the path of a failure deep inside the document", () => {
    const document =
      `<Patient xmlns="${FHIR}"><name><given value="A"/>` +
      `<period><start value="never"/></period></name></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.name[0].period.start: expected dateTime"
    )
  })
})

describe("refusing an object that is not a resource", () => {
  it("refuses a body that is not an object", () => {
    expect(bad(serialize("Patient"))).toBe(
      "document: expected a resource object"
    )
  })

  it("refuses a body with no resource type", () => {
    expect(bad(serialize({ id: "x" }))).toBe(
      "document: expected a resource type"
    )
  })

  it("refuses an unknown resource type", () => {
    expect(bad(serialize({ resourceType: "Widget" }))).toBe(
      "document: unknown resource type Widget"
    )
  })

  it("refuses an element that is not declared", () => {
    expect(bad(serialize({ resourceType: "Patient", nickname: "A" }))).toBe(
      "Patient.nickname: element is not declared"
    )
  })

  it("refuses a single value given as an array", () => {
    const body = { resourceType: "Patient", birthDate: ["1956-05-12"] }
    expect(bad(serialize(body))).toBe(
      "Patient.birthDate: expected a single value"
    )
  })

  it("refuses a repeating element given as a single value", () => {
    const body = { resourceType: "Patient", name: { family: "A" } }
    expect(bad(serialize(body))).toBe("Patient.name: expected an array")
  })

  it("refuses a group that is not an object", () => {
    const body = { resourceType: "Patient", managingOrganization: "Org/1" }
    expect(bad(serialize(body))).toBe(
      "Patient.managingOrganization: expected an object"
    )
  })

  it("refuses a value whose type is wrong", () => {
    const body = { resourceType: "Patient", active: "true" }
    expect(bad(serialize(body))).toBe("Patient.active: expected boolean")
  })

  it("refuses an extension with no url", () => {
    const body = { resourceType: "Patient", extension: [{ valueString: "x" }] }
    expect(bad(serialize(body))).toBe(
      "Patient.extension[0].url: required element is absent"
    )
  })

  it("refuses an extension value that is not declared", () => {
    const body = {
      resourceType: "Patient",
      extension: [{ url: "http://example.org/x", valueMoney: { value: 1 } }]
    }
    expect(bad(serialize(body))).toBe(
      "Patient.extension[0].valueMoney: element is not declared"
    )
  })

  it("refuses a contained value that is not a resource", () => {
    const body = { resourceType: "Patient", contained: ["Condition/c1"] }
    expect(bad(serialize(body))).toBe(
      "Patient.contained[0]: expected a resource object"
    )
  })

  it("refuses a primitive and its shadow that are both absent", () => {
    const body = {
      resourceType: "Patient",
      name: [{ given: ["A", null] }]
    }
    expect(bad(serialize(body))).toBe(
      "Patient.name[0].given[1]: an element must carry a value or an extension"
    )
  })
})

describe("refusing hostile input", () => {
  it("refuses a document type declaration", () => {
    const document =
      `<!DOCTYPE Patient><Patient xmlns="${FHIR}"/>`
    expect(bad(parse(document))).toBe(
      "document: a document type declaration is not accepted"
    )
  })

  it("refuses an external entity declaration", () => {
    const document =
      `<?xml version="1.0"?><!DOCTYPE Patient [<!ENTITY xxe SYSTEM ` +
      `"file:///etc/passwd">]><Patient xmlns="${FHIR}">` +
      `<birthDate value="&xxe;"/></Patient>`
    expect(bad(parse(document))).toBe(
      "document: a document type declaration is not accepted"
    )
  })

  it("refuses a bare entity declaration", () => {
    const document = `<!ENTITY lol "ha"><Patient xmlns="${FHIR}"/>`
    expect(bad(parse(document))).toBe(
      "document: an entity declaration is not accepted"
    )
  })

  it("refuses an entity reference the specification does not define", () => {
    const document =
      `<Patient xmlns="${FHIR}"><birthDate value="&xxe;"/></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.birthDate: unknown entity reference &xxe;"
    )
  })

  it("refuses an entity reference that is never closed", () => {
    const document =
      `<Patient xmlns="${FHIR}"><name><text value="&amp"/></name></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.name.text: an entity reference is not closed"
    )
  })

  it("refuses nesting deeper than the limit", () => {
    const document =
      `<Patient xmlns="${FHIR}">${"<a>".repeat(200)}` +
      `${"</a>".repeat(200)}</Patient>`
    expect(bad(parse(document))).toContain("nesting deeper than 64 elements")
  })

  it("refuses more elements than the limit", () => {
    const document =
      `<Patient xmlns="${FHIR}">${'<a value="1"/>'.repeat(40)}</Patient>`
    expect(bad(parse(document, { limits: { nodes: 8 } }))).toBe(
      "document: more than 8 elements"
    )
  })

  it("refuses a document longer than the limit", () => {
    const document = `<Patient xmlns="${FHIR}"/>`
    expect(bad(parse(document, { limits: { length: 4 } }))).toBe(
      "document: longer than 4 characters"
    )
  })

  it("refuses a processing instruction", () => {
    const document = `<?php echo 1; ?><Patient xmlns="${FHIR}"/>`
    expect(bad(parse(document))).toBe(
      "document: a processing instruction is not accepted"
    )
  })

  it("refuses a marked section", () => {
    const document =
      `<Patient xmlns="${FHIR}"><name><![CDATA[x]]></name></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.name: a marked section is not accepted"
    )
  })

  it("refuses an object nested deeper than the limit", () => {
    let held: Record<string, unknown> = {
      url: "http://example.org/leaf",
      valueString: "x"
    }
    for (let index = 0; index < 100; index += 1) {
      held = { url: "http://example.org/n", extension: [held] }
    }
    const body = { resourceType: "Patient", extension: [held] }
    expect(bad(serialize(body))).toContain("nesting deeper than 64 elements")
  })

  it("refuses content after the root element", () => {
    const document = `<Patient xmlns="${FHIR}"/><Patient xmlns="${FHIR}"/>`
    expect(bad(parse(document))).toBe(
      "document: content after the root element"
    )
  })

  it("ignores whitespace inside a primitive and a container", () => {
    const document =
      `<Patient xmlns="${FHIR}">\n  <contained>\n    <Condition/>\n` +
      `  </contained>\n  <birthDate value="1956-05-12">\n  </birthDate>\n` +
      `</Patient>`
    expect(run(parse(document))).toEqual({
      resourceType: "Patient",
      contained: [{ resourceType: "Condition" }],
      birthDate: "1956-05-12"
    })
  })

  it("refuses text content beside a contained resource", () => {
    const document =
      `<Patient xmlns="${FHIR}"><contained>x<Condition/></contained></Patient>`
    expect(bad(parse(document))).toBe(
      "Patient.contained[0]: text content is not accepted"
    )
  })

  it("refuses a shadow extension that is not an array", () => {
    const body = {
      resourceType: "Patient",
      birthDate: "1956-05-12",
      _birthDate: { extension: { url: "http://example.org/x" } }
    }
    expect(bad(serialize(body))).toBe(
      "Patient._birthDate.extension: expected an array"
    )
  })

  it("refuses an empty document", () => {
    expect(bad(parse("   "))).toBe("document: expected an element")
  })
})

describe("reporting a failure", () => {
  it("answers with an operation outcome naming the path", () => {
    const document = `<Patient xmlns="${FHIR}"><active value="yes"/></Patient>`
    expect(toOutcome(failed(parse(document)))).toEqual({
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "invalid",
          diagnostics: "Patient.active: expected boolean"
        }
      ]
    })
  })

  it("answers with an operation outcome when serializing fails", () => {
    expect(toOutcome(failed(serialize({ resourceType: "Widget" })))).toEqual({
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "invalid",
          diagnostics: "document: unknown resource type Widget"
        }
      ]
    })
  })
})

describe("a supplied definition set", () => {
  const ODD: Definition = {
    type: "Odd",
    elements: { note: group({ text: el("string") }, "0..1") }
  }

  const find = (type: string): Definition | undefined =>
    type === "Odd" ? ODD : undefined

  it("drives the conversion from the definitions it is given", () => {
    const body = { resourceType: "Odd", note: { text: "hello" } }
    const document = run(serialize(body, { find }))
    expect(document).toBe(
      `<Odd xmlns="${FHIR}"><note><text value="hello"/></note></Odd>`
    )
    expect(run(parse(document, { find }))).toEqual(body)
  })

  it("refuses a type the supplied definitions do not declare", () => {
    expect(bad(serialize({ resourceType: "Patient" }, { find }))).toBe(
      "document: unknown resource type Patient"
    )
  })
})
