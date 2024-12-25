import { Effect } from "effect"
import { tools } from "../agent/tools.js"
import type { ToolSpec } from "../agent/tools.js"
import type { Failure } from "../core/outcome.js"
import { REGISTRIES, registryOf } from "./versions.js"
import type { Registry } from "./versions.js"

export type ParamType =
  | "number"
  | "date"
  | "string"
  | "token"
  | "reference"
  | "composite"
  | "quantity"
  | "uri"
  | "special"

export interface SearchParam {
  readonly name: string
  readonly type: ParamType
}

export interface Interaction {
  readonly code: string
}

export interface ResourceEntry {
  readonly type: string
  readonly interaction: ReadonlyArray<Interaction>
  readonly searchParam: ReadonlyArray<SearchParam>
}

export interface Rest {
  readonly mode: "server"
  readonly interaction: ReadonlyArray<Interaction>
  readonly resource: ReadonlyArray<ResourceEntry>
}

export interface Software {
  readonly name: string
  readonly version: string
}

export interface Build {
  readonly software: Software
  readonly date: string
}

export interface CapabilityStatement {
  readonly resourceType: "CapabilityStatement"
  readonly status: "active"
  readonly kind: "instance"
  readonly date: string
  readonly software: Software
  readonly fhirVersion: string
  readonly format: ReadonlyArray<string>
  readonly rest: ReadonlyArray<Rest>
}

const RESOURCE_PROVIDER: Readonly<Record<string, string>> = {
  read: "read",
  vread: "vread",
  "search-type": "search",
  "history-instance": "history",
  "history-type": "history",
  create: "create",
  update: "update",
  patch: "patch",
  delete: "delete"
}

const SYSTEM_PROVIDER: Readonly<Record<string, string>> = {
  capabilities: "capabilities",
  "search-system": "search_system",
  "history-system": "history",
  transaction: "transaction",
  batch: "batch"
}

const TOKEN_TAIL = new Set(["id", "code", "status", "gender", "system"])

export const providerOf = (code: string): string | undefined =>
  RESOURCE_PROVIDER[code] ?? SYSTEM_PROVIDER[code]

export const paramType = (path: ReadonlyArray<string>): ParamType => {
  const tail = path[path.length - 1]
  if (tail === undefined) return "special"
  if (path.includes("identifier")) return "token"
  if (path.includes("reference")) return "reference"
  if (/date$/i.test(tail)) return "date"
  return TOKEN_TAIL.has(tail) ? "token" : "string"
}

const served = (
  providers: Readonly<Record<string, string>>,
  specs: ReadonlyArray<ToolSpec>
): ReadonlyArray<Interaction> => {
  const names = new Set(specs.map((spec) => spec.name))
  return Object.entries(providers)
    .filter(([, provider]) => names.has(provider))
    .map(([code]) => ({ code }))
}

const entryOf = (
  registry: Registry,
  type: string,
  specs: ReadonlyArray<ToolSpec>
): ResourceEntry => ({
  type,
  interaction: served(RESOURCE_PROVIDER, specs),
  searchParam: Object.entries(registry.parametersOf(type) ?? {}).map(
    ([name, declared]) => ({ name, type: paramType(declared.path) })
  )
})

export const statement = (
  build: Build,
  registry: Registry,
  specs: ReadonlyArray<ToolSpec> = tools
): CapabilityStatement => ({
  resourceType: "CapabilityStatement",
  status: "active",
  kind: "instance",
  date: build.date,
  software: build.software,
  fhirVersion: registry.fhirVersion,
  format: ["application/fhir+json"],
  rest: [
    {
      mode: "server",
      interaction: served(SYSTEM_PROVIDER, specs),
      resource: registry.types().map((type) => entryOf(registry, type, specs))
    }
  ]
})

export const statements = (
  build: Build,
  registries: ReadonlyArray<Registry> = REGISTRIES,
  specs: ReadonlyArray<ToolSpec> = tools
): ReadonlyArray<CapabilityStatement> =>
  registries.map((registry) => statement(build, registry, specs))

export const statementFor = (
  build: Build,
  fhirVersion: string,
  registries: ReadonlyArray<Registry> = REGISTRIES,
  specs: ReadonlyArray<ToolSpec> = tools
): Effect.Effect<CapabilityStatement, Failure> =>
  registryOf(fhirVersion, registries).pipe(
    Effect.map((registry) => statement(build, registry, specs))
  )
