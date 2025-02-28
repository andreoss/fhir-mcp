const INDEX = /^fhir:\/\/([A-Z][A-Za-z]{1,63})$/
const RESOURCE = /^fhir:\/\/([A-Z][A-Za-z]{1,63})\/([A-Za-z0-9\-.]{1,64})$/
const VERSIONED =
  /^fhir:\/\/([A-Z][A-Za-z]{1,63})\/([A-Za-z0-9\-.]{1,64})\/_history\/([0-9]+)$/

export interface Address {
  readonly type: string
  readonly id?: string
  readonly version?: string
}

export interface ResourceEntry {
  readonly uri: string
  readonly name: string
  readonly description: string
  readonly mimeType: string
}

export interface TemplateEntry {
  readonly uriTemplate: string
  readonly name: string
  readonly description: string
  readonly mimeType: string
}

export const uriOf = (type: string, id?: string, version?: string): string => {
  if (version !== undefined) return `fhir://${type}/${id}/_history/${version}`
  if (id !== undefined) return `fhir://${type}/${id}`
  return `fhir://${type}`
}

export const address = (uri: string): Address | undefined => {
  const indexed = INDEX.exec(uri)
  if (indexed !== null) return { type: indexed[1]! }
  const resolved = RESOURCE.exec(uri)
  if (resolved !== null) return { type: resolved[1]!, id: resolved[2]! }
  const versioned = VERSIONED.exec(uri)
  if (versioned !== null) {
    return { type: versioned[1]!, id: versioned[2]!, version: versioned[3]! }
  }
  return undefined
}

export const TEMPLATES: ReadonlyArray<TemplateEntry> = [
  {
    uriTemplate: "fhir://{type}/{id}",
    name: "resource by type and id",
    description: "One resource addressed by its type and logical id.",
    mimeType: "application/fhir+json"
  },
  {
    uriTemplate: "fhir://{type}/{id}/_history/{version}",
    name: "resource version",
    description: "One version of a resource addressed by type, id and version.",
    mimeType: "application/fhir+json"
  }
]