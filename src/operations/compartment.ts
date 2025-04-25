export const COMPARTMENT: Record<string, string> = {
  Condition: "$.subject.reference",
  DocumentReference: "$.subject.reference",
  Encounter: "$.subject.reference",
  Observation: "$.subject.reference"
}

export const TYPES: ReadonlyArray<string> = ["Patient", ...Object.keys(COMPARTMENT)]

export const inCompartment = (type: string): boolean =>
  type === "Patient" || COMPARTMENT[type] !== undefined
