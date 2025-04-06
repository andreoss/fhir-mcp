export type Content = "complete" | "fragment" | "example" | "supplement" | "not-present"

export type Absence = Content | "referenced"

export interface Designation {
  readonly language?: string
  readonly use?: string
  readonly value: string
}

export interface Concept {
  readonly code: string
  readonly display?: string
  readonly parent?: string
  readonly inactive?: boolean
  readonly designation?: ReadonlyArray<Designation>
}

export interface CodeSystem {
  readonly url: string
  readonly version?: string
  readonly date?: string
  readonly caseSensitive?: boolean
  readonly content: Content
  readonly concept: ReadonlyArray<Concept>
}

export interface Unsupplied {
  readonly url: string
  readonly version?: string
  readonly content: Absence
  readonly reason: string
}

export interface Filter {
  readonly property: string
  readonly op: string
  readonly value: string
}

export interface Include {
  readonly system: string
  readonly version?: string
  readonly concept?: ReadonlyArray<{ readonly code: string }>
  readonly filter?: ReadonlyArray<Filter>
}

export interface ValueSet {
  readonly url: string
  readonly version?: string
  readonly include: ReadonlyArray<Include>
  readonly exclude?: ReadonlyArray<Include>
}

export interface Sources {
  readonly stored?: ReadonlyArray<CodeSystem>
  readonly loaded?: ReadonlyArray<CodeSystem>
  readonly published?: ReadonlyArray<CodeSystem>
  readonly unsupplied?: ReadonlyArray<Unsupplied>
  readonly valueSets?: ReadonlyArray<ValueSet>
}

export type Resolved =
  | { readonly _tag: "System"; readonly system: CodeSystem }
  | { readonly _tag: "Unsupplied"; readonly record: Unsupplied }
  | { readonly _tag: "Unknown"; readonly url: string }

const REASONS: Record<Absence, string> = {
  complete: "declared complete and carries no concept here",
  fragment: "carries a fragment, not the full content",
  example: "carries example content only",
  supplement: "carries a supplement, not the content",
  "not-present": "declares that it carries no content",
  referenced: "named by a value set and defined by no publication held here"
}

export const reasonFor = (content: Absence): string => REASONS[content]

export const unsupplied = (url: string, content: Absence, version?: string): Unsupplied => ({
  url,
  content,
  reason: reasonFor(content),
  ...(version === undefined ? {} : { version })
})

export const byCode = (system: CodeSystem): ReadonlyMap<string, Concept> => {
  const index = new Map<string, Concept>()
  for (const concept of system.concept) index.set(concept.code, concept)
  return index
}

export const findConcept = (system: CodeSystem, code: string): Concept | undefined => {
  const exact = byCode(system).get(code)
  if (exact !== undefined || system.caseSensitive !== false) return exact
  const lower = code.toLowerCase()
  return system.concept.find((concept) => concept.code.toLowerCase() === lower)
}

export const ancestorOf = (system: CodeSystem, ancestor: string, code: string): boolean => {
  const index = byCode(system)
  const seen = new Set<string>()
  let current = index.get(code)?.parent
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = index.get(current)?.parent
  }
  return false
}

const pick = (
  systems: ReadonlyArray<CodeSystem>,
  url: string,
  version: string | undefined
): CodeSystem | undefined => {
  const at = systems.filter((system) => system.url === url)
  if (version === undefined) {
    return at.find((system) => system.version === undefined) ?? at[at.length - 1]
  }
  return (
    at.find((system) => system.version === version) ??
    at.find((system) => system.version === undefined)
  )
}

export const resolve = (sources: Sources, url: string, version?: string): Resolved => {
  const system =
    pick(sources.stored ?? [], url, version) ??
    pick(sources.loaded ?? [], url, version) ??
    pick(sources.published ?? [], url, version)
  if (system !== undefined) return { _tag: "System", system }
  const record = (sources.unsupplied ?? []).find(
    (held) =>
      held.url === url &&
      (version === undefined || held.version === undefined || held.version === version)
  )
  if (record !== undefined) return { _tag: "Unsupplied", record }
  return { _tag: "Unknown", url }
}

export const asOf = (sources: Sources, date: string): Sources => {
  const keep = (systems: ReadonlyArray<CodeSystem> | undefined) =>
    (systems ?? []).filter((system) => system.date === undefined || system.date <= date)
  return {
    stored: keep(sources.stored),
    loaded: keep(sources.loaded),
    published: keep(sources.published),
    unsupplied: sources.unsupplied ?? [],
    valueSets: sources.valueSets ?? []
  }
}
