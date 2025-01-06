import { parametersOf, types } from "../store/definitions.js"
import type { Component, Modifier, ValueType } from "./tree.js"

export interface Param {
  readonly valueType: ValueType
  readonly targets: ReadonlyArray<string>
  readonly components: ReadonlyArray<Component>
}

const plain = (valueType: ValueType): Param => ({ valueType, targets: [], components: [] })

const ref = (...targets: ReadonlyArray<string>): Param => ({
  valueType: "reference",
  targets,
  components: []
})

const composite = (...components: ReadonlyArray<Component>): Param => ({
  valueType: "composite",
  targets: [],
  components
})

const COMMON: Record<string, Param> = {
  _id: plain("token"),
  _lastUpdated: plain("date"),
  _profile: plain("uri"),
  _tag: plain("token"),
  _security: plain("token"),
  _list: plain("string"),
  _type: plain("token")
}

const TYPED: Record<string, Record<string, Param>> = {
  Patient: {
    family: plain("string"),
    given: plain("string"),
    name: plain("string"),
    birthdate: plain("date"),
    identifier: plain("token"),
    gender: plain("token"),
    deceased: plain("token"),
    "death-date": plain("date"),
    "general-practitioner": ref("Practitioner", "Organization"),
    organization: ref("Organization"),
    link: ref("Patient")
  },
  Observation: {
    status: plain("token"),
    code: plain("token"),
    identifier: plain("token"),
    date: plain("date"),
    subject: ref("Patient", "Group", "Device", "Location"),
    patient: ref("Patient"),
    encounter: ref("Encounter"),
    "value-quantity": plain("quantity"),
    "value-string": plain("string"),
    "code-value-quantity": composite(
      { name: "code", valueType: "token" },
      { name: "value", valueType: "quantity" }
    )
  },
  Condition: {
    clinicalstatus: plain("token"),
    code: plain("token"),
    severity: plain("token"),
    "onset-date": plain("date"),
    subject: ref("Patient", "Group"),
    patient: ref("Patient"),
    encounter: ref("Encounter")
  },
  Encounter: {
    status: plain("token"),
    date: plain("date"),
    length: plain("number"),
    subject: ref("Patient"),
    patient: ref("Patient"),
    "part-of": ref("Encounter")
  }
}

const known = new Set(types())

export const isType = (name: string): boolean => known.has(name)

export const paramsOf = (type: string): Record<string, Param> | undefined => {
  const stored = parametersOf(type)
  if (stored === undefined) return undefined
  const fallback = Object.fromEntries(
    Object.keys(stored).map((name) => [name, plain("string")] as const)
  )
  return { ...fallback, ...COMMON, ...TYPED[type] }
}

export const ORDERED: ReadonlySet<ValueType> = new Set<ValueType>([
  "number",
  "date",
  "quantity"
])

const ALLOWED: Record<ValueType, ReadonlyArray<Modifier>> = {
  number: [],
  date: [],
  string: ["exact", "contains"],
  token: ["text", "not", "above", "below", "in", "not-in", "of-type"],
  quantity: [],
  reference: ["type", "identifier", "above", "below"],
  composite: [],
  uri: ["below", "above", "contains"]
}

export const MODIFIERS: ReadonlySet<string> = new Set<Modifier>([
  "missing",
  "exact",
  "contains",
  "not",
  "text",
  "in",
  "not-in",
  "below",
  "above",
  "type",
  "identifier",
  "of-type"
])

export const allows = (valueType: ValueType, modifier: Modifier): boolean =>
  modifier === "missing" || ALLOWED[valueType].includes(modifier)
