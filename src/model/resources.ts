import { el, group, open } from "./shape.js"
import type { Card, Definition, Elements } from "./shape.js"

const ELEMENT: Elements = {
  id: el("string"),
  extension: open("0..*"),
  modifierExtension: open("0..*")
}

const nest = (children: Elements, card: Card = "0..1") =>
  group({ ...ELEMENT, ...children }, card)

const CODING: Elements = {
  system: el("uri"),
  version: el("string"),
  code: el("code"),
  display: el("string"),
  userSelected: el("boolean")
}

const CONCEPT: Elements = {
  coding: nest(CODING, "0..*"),
  text: el("string")
}

const REFERENCE: Elements = {
  reference: el("string"),
  type: el("uri"),
  display: el("string")
}

const PERIOD: Elements = {
  start: el("dateTime"),
  end: el("dateTime")
}

const IDENTIFIER: Elements = {
  use: el("code"),
  type: nest(CONCEPT),
  system: el("uri"),
  value: el("string"),
  period: nest(PERIOD)
}

const QUANTITY: Elements = {
  value: el("decimal"),
  comparator: el("code"),
  unit: el("string"),
  system: el("uri"),
  code: el("code")
}

const ANNOTATION: Elements = {
  text: el("string", "1..1"),
  time: el("dateTime")
}

const META: Elements = {
  versionId: el("id"),
  lastUpdated: el("instant"),
  source: el("uri"),
  profile: el("uri", "0..*"),
  security: nest(CODING, "0..*"),
  tag: nest(CODING, "0..*")
}

const NARRATIVE: Elements = {
  status: el("code", "1..1"),
  div: el("string", "1..1")
}

const BASE: Elements = {
  id: el("id"),
  meta: nest(META),
  implicitRules: el("uri"),
  language: el("code"),
  text: nest(NARRATIVE),
  contained: open("0..*"),
  extension: open("0..*"),
  modifierExtension: open("0..*")
}

const HUMAN_NAME: Elements = {
  use: el("code"),
  text: el("string"),
  family: el("string"),
  given: el("string", "0..*"),
  prefix: el("string", "0..*"),
  suffix: el("string", "0..*"),
  period: nest(PERIOD)
}

const CONTACT_POINT: Elements = {
  system: el("code"),
  value: el("string"),
  use: el("code"),
  rank: el("integer"),
  period: nest(PERIOD)
}

const ADDRESS: Elements = {
  use: el("code"),
  type: el("code"),
  text: el("string"),
  line: el("string", "0..*"),
  city: el("string"),
  district: el("string"),
  state: el("string"),
  postalCode: el("string"),
  country: el("string"),
  period: nest(PERIOD)
}

const PATIENT: Elements = {
  identifier: nest(IDENTIFIER, "0..*"),
  active: el("boolean"),
  name: nest(HUMAN_NAME, "0..*"),
  telecom: nest(CONTACT_POINT, "0..*"),
  gender: el("code"),
  birthDate: el("date"),
  deceasedBoolean: el("boolean"),
  deceasedDateTime: el("dateTime"),
  address: nest(ADDRESS, "0..*"),
  maritalStatus: nest(CONCEPT),
  multipleBirthBoolean: el("boolean"),
  multipleBirthInteger: el("integer"),
  communication: nest(
    { language: nest(CONCEPT, "1..1"), preferred: el("boolean") },
    "0..*"
  ),
  generalPractitioner: nest(REFERENCE, "0..*"),
  managingOrganization: nest(REFERENCE)
}

const OBSERVATION: Elements = {
  identifier: nest(IDENTIFIER, "0..*"),
  status: el("code", "1..1"),
  category: nest(CONCEPT, "0..*"),
  code: nest(CONCEPT, "1..1"),
  subject: nest(REFERENCE),
  encounter: nest(REFERENCE),
  effectiveDateTime: el("dateTime"),
  effectivePeriod: nest(PERIOD),
  issued: el("instant"),
  performer: nest(REFERENCE, "0..*"),
  valueQuantity: nest(QUANTITY),
  valueCodeableConcept: nest(CONCEPT),
  valueString: el("string"),
  valueBoolean: el("boolean"),
  valueInteger: el("integer"),
  valueDateTime: el("dateTime"),
  dataAbsentReason: nest(CONCEPT),
  interpretation: nest(CONCEPT, "0..*"),
  note: nest(ANNOTATION, "0..*"),
  bodySite: nest(CONCEPT),
  method: nest(CONCEPT),
  hasMember: nest(REFERENCE, "0..*"),
  derivedFrom: nest(REFERENCE, "0..*"),
  component: nest(
    {
      code: nest(CONCEPT, "1..1"),
      valueQuantity: nest(QUANTITY),
      valueCodeableConcept: nest(CONCEPT),
      valueString: el("string"),
      dataAbsentReason: nest(CONCEPT),
      interpretation: nest(CONCEPT, "0..*")
    },
    "0..*"
  )
}

const CONDITION: Elements = {
  identifier: nest(IDENTIFIER, "0..*"),
  clinicalStatus: nest(CONCEPT),
  verificationStatus: nest(CONCEPT),
  category: nest(CONCEPT, "0..*"),
  severity: nest(CONCEPT),
  code: nest(CONCEPT),
  bodySite: nest(CONCEPT, "0..*"),
  subject: nest(REFERENCE, "1..1"),
  encounter: nest(REFERENCE),
  onsetDateTime: el("dateTime"),
  onsetPeriod: nest(PERIOD),
  onsetString: el("string"),
  abatementDateTime: el("dateTime"),
  recordedDate: el("dateTime"),
  recorder: nest(REFERENCE),
  asserter: nest(REFERENCE),
  note: nest(ANNOTATION, "0..*")
}

const ENCOUNTER: Elements = {
  identifier: nest(IDENTIFIER, "0..*"),
  status: el("code", "1..1"),
  class: nest(CODING, "1..1"),
  type: nest(CONCEPT, "0..*"),
  serviceType: nest(CONCEPT),
  priority: nest(CONCEPT),
  subject: nest(REFERENCE),
  participant: nest(
    {
      type: nest(CONCEPT, "0..*"),
      period: nest(PERIOD),
      individual: nest(REFERENCE)
    },
    "0..*"
  ),
  period: nest(PERIOD),
  length: nest(QUANTITY),
  reasonCode: nest(CONCEPT, "0..*"),
  reasonReference: nest(REFERENCE, "0..*"),
  diagnosis: nest(
    {
      condition: nest(REFERENCE, "1..1"),
      use: nest(CONCEPT),
      rank: el("integer")
    },
    "0..*"
  ),
  hospitalization: nest({
    admitSource: nest(CONCEPT),
    dischargeDisposition: nest(CONCEPT)
  }),
  location: nest(
    {
      location: nest(REFERENCE, "1..1"),
      status: el("code"),
      period: nest(PERIOD)
    },
    "0..*"
  ),
  serviceProvider: nest(REFERENCE),
  partOf: nest(REFERENCE)
}

const definition = (type: string, elements: Elements): Definition => ({
  type,
  elements: { ...BASE, ...elements }
})

export const DEFINITIONS: Record<string, Definition> = {
  Patient: definition("Patient", PATIENT),
  Observation: definition("Observation", OBSERVATION),
  Condition: definition("Condition", CONDITION),
  Encounter: definition("Encounter", ENCOUNTER)
}

export const definitionOf = (type: string): Definition | undefined =>
  DEFINITIONS[type]

export const types = (): ReadonlyArray<string> => Object.keys(DEFINITIONS)
