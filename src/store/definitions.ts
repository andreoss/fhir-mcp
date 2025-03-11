export interface ParameterDefinition {
  readonly path: ReadonlyArray<string>
}

export type TypeDefinition = Record<string, ParameterDefinition>

export const COMMON: TypeDefinition = {
  _id: { path: ["id"] }
}

export const DEFINITIONS: Record<string, TypeDefinition> = {
  Patient: {
    family: { path: ["name", "family"] },
    given: { path: ["name", "given"] },
    birthdate: { path: ["birthDate"] },
    identifier: { path: ["identifier", "value"] },
    gender: { path: ["gender"] }
  },
  Observation: {
    status: { path: ["status"] },
    code: { path: ["code", "coding", "code"] },
    subject: { path: ["subject", "reference"] }
  },
  Condition: {
    clinicalstatus: { path: ["clinicalStatus", "coding", "code"] },
    code: { path: ["code", "coding", "code"] },
    subject: { path: ["subject", "reference"] }
  },
  Encounter: {
    status: { path: ["status"] },
    subject: { path: ["subject", "reference"] }
  }
}

export const parametersOf = (type: string): TypeDefinition | undefined => {
  const own = DEFINITIONS[type]
  return own === undefined ? undefined : { ...COMMON, ...own }
}

export const types = (): ReadonlyArray<string> => Object.keys(DEFINITIONS)

export const walk = (value: unknown, path: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap((item) => walk(item, path))
  if (path.length === 0) {
    if (typeof value === "string") return [value]
    if (typeof value === "number" || typeof value === "boolean") return [String(value)]
    return []
  }
  const [head, ...rest] = path
  if (value === null || typeof value !== "object") return []
  return walk((value as Record<string, unknown>)[head as string], rest)
}
