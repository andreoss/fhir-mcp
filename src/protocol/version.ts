import { readFileSync } from "node:fs"

export const NAME = "fhir-mcp"

const UNKNOWN = "0.0.0"

export interface Probe {
  readonly name: string
  readonly version: string
}

const packaged = (): string => {
  try {
    const file = readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    const version = (JSON.parse(file) as { version?: unknown }).version
    return typeof version === "string" && version.length > 0 ? version : UNKNOWN
  } catch {
    return UNKNOWN
  }
}

export const VERSION = packaged()

export const probe = (): Probe => ({ name: NAME, version: VERSION })
