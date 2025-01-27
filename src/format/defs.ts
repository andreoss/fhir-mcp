import { el, group, open } from "../model/shape.js"
import { definitionOf } from "../model/resources.js"
import type { Card, Definition, Elements } from "../model/shape.js"

export const FHIR = "http://hl7.org/fhir"

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

const PERIOD: Elements = {
  start: el("dateTime"),
  end: el("dateTime")
}

const REFERENCE: Elements = {
  reference: el("string"),
  type: el("uri"),
  display: el("string")
}

const QUANTITY: Elements = {
  value: el("decimal"),
  comparator: el("code"),
  unit: el("string"),
  system: el("uri"),
  code: el("code")
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

const RESOURCE: Elements = {
  id: el("id"),
  meta: nest(META),
  implicitRules: el("uri"),
  language: el("code")
}

const DOMAIN: Elements = {
  ...RESOURCE,
  text: nest(NARRATIVE),
  contained: open("0..*"),
  extension: open("0..*"),
  modifierExtension: open("0..*")
}

export const EXTENSION: Elements = {
  id: el("string"),
  extension: open("0..*"),
  url: el("uri", "1..1"),
  valueBoolean: el("boolean"),
  valueInteger: el("integer"),
  valueDecimal: el("decimal"),
  valueString: el("string"),
  valueUri: el("uri"),
  valueCode: el("code"),
  valueId: el("id"),
  valueDate: el("date"),
  valueDateTime: el("dateTime"),
  valueInstant: el("instant"),
  valueCoding: nest(CODING),
  valueCodeableConcept: nest(CONCEPT),
  valueQuantity: nest(QUANTITY),
  valuePeriod: nest(PERIOD),
  valueReference: nest(REFERENCE)
}

const LINK: Elements = {
  relation: el("string", "1..1"),
  url: el("uri", "1..1")
}

const SEARCH: Elements = {
  mode: el("code"),
  score: el("decimal")
}

const REQUEST: Elements = {
  method: el("code", "1..1"),
  url: el("uri", "1..1"),
  ifNoneMatch: el("string"),
  ifModifiedSince: el("instant"),
  ifMatch: el("string"),
  ifNoneExist: el("string")
}

const RESPONSE: Elements = {
  status: el("string", "1..1"),
  location: el("uri"),
  etag: el("string"),
  lastModified: el("instant"),
  outcome: open()
}

const ENTRY: Elements = {
  link: nest(LINK, "0..*"),
  fullUrl: el("uri"),
  resource: open(),
  search: nest(SEARCH),
  request: nest(REQUEST),
  response: nest(RESPONSE)
}

export const BUNDLE: Definition = {
  type: "Bundle",
  elements: {
    ...RESOURCE,
    type: el("code", "1..1"),
    timestamp: el("instant"),
    total: el("integer"),
    link: nest(LINK, "0..*"),
    entry: nest(ENTRY, "0..*")
  }
}

const ISSUE: Elements = {
  severity: el("code", "1..1"),
  code: el("code", "1..1"),
  details: nest(CONCEPT),
  diagnostics: el("string"),
  expression: el("string", "0..*")
}

export const OUTCOME: Definition = {
  type: "OperationOutcome",
  elements: { ...DOMAIN, issue: nest(ISSUE, "1..*") }
}

const OWN: Record<string, Definition> = {
  Bundle: BUNDLE,
  OperationOutcome: OUTCOME
}

export const lookup = (type: string): Definition | undefined =>
  OWN[type] ?? definitionOf(type)
