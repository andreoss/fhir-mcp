import { etagOf } from "../core/interactions.js"
import { Rejected, statusOf, toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export const FHIR_JSON = "application/fhir+json"
export const FHIR_XML = "application/fhir+xml"
export const NOT_ACCEPTABLE = 406
export const NOT_MODIFIED = 304
const OK = 200

const JSON_TYPES: ReadonlyArray<string> = [
  FHIR_JSON,
  "application/json+fhir",
  "application/json",
  "text/json"
]

const XML_TYPES: ReadonlyArray<string> = [
  FHIR_XML,
  "application/xml+fhir",
  "application/xml",
  "text/xml"
]

const RANGE = /^[^\s/]+\/[^\s/]+$/

export type Format = "json" | "xml"

export interface Representation {
  readonly format: Format
  readonly mediaType: string
  readonly pretty: boolean
  readonly served: boolean
}

export interface Refusal {
  readonly status: number
  readonly failure: Failure
}

export type Choice =
  | { readonly kind: "serve"; readonly rep: Representation }
  | { readonly kind: "defer"; readonly rep: Representation }
  | { readonly kind: "refuse"; readonly refusal: Refusal }

export interface Ask {
  readonly accept: string | undefined
  readonly format: string | undefined
  readonly pretty: string | undefined
}

export interface Stamp {
  readonly versionId: number
  readonly lastUpdated: string
}

export interface Tags {
  readonly etag: string
  readonly lastModified: string | undefined
}

export interface Conditions {
  readonly ifNoneMatch: string | undefined
  readonly ifModifiedSince: string | undefined
}

export interface Freshness {
  readonly notModified: boolean
  readonly status: number
}

export interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export const DEFAULT: Representation = {
  format: "json",
  mediaType: FHIR_JSON,
  pretty: false,
  served: true
}

interface Candidate {
  readonly range: string
  readonly q: number
  readonly rank: number
  readonly order: number
}

const repOf = (mediaType: string, pretty: boolean): Representation =>
  JSON_TYPES.includes(mediaType)
    ? { format: "json", mediaType, pretty, served: true }
    : { format: "xml", mediaType, pretty, served: false }

const chosen = (rep: Representation): Choice =>
  rep.served ? { kind: "serve", rep } : { kind: "defer", rep }

const refuse = (status: number, reason: string): Choice => ({
  kind: "refuse",
  refusal: { status, failure: new Rejected({ reason }) }
})

const named = (value: string): string | undefined => {
  if (value === "json") return FHIR_JSON
  if (value === "xml") return FHIR_XML
  return [...JSON_TYPES, ...XML_TYPES].find((type) => type === value)
}

const matched = (range: string): string | undefined => {
  if (range === "*/*") return FHIR_JSON
  const [type = "", sub = ""] = range.split("/")
  const known = [...JSON_TYPES, ...XML_TYPES]
  return sub === "*"
    ? known.find((entry) => entry.startsWith(`${type}/`))
    : known.find((entry) => entry === range)
}

const candidateOf = (entry: string, order: number): Candidate | undefined => {
  const parts = entry.split(";").map((part) => part.trim())
  const range = (parts[0] ?? "").toLowerCase()
  if (!RANGE.test(range)) return undefined
  let q = 1
  for (const param of parts.slice(1)) {
    if (!param.toLowerCase().startsWith("q=")) continue
    const asked = Number(param.slice(2))
    if (!Number.isFinite(asked) || asked < 0 || asked > 1) return undefined
    q = asked
  }
  const [, sub = ""] = range.split("/")
  return { range, q, rank: range === "*/*" ? 0 : sub === "*" ? 1 : 2, order }
}

const fromAccept = (header: string, pretty: boolean): Choice => {
  const entries = header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const candidates: Array<Candidate> = []
  for (const [order, entry] of entries.entries()) {
    const candidate = candidateOf(entry, order)
    if (candidate === undefined) {
      return refuse(400, "accept header not understood")
    }
    candidates.push(candidate)
  }
  const ordered = candidates
    .filter((candidate) => candidate.q > 0)
    .sort((a, b) => b.q - a.q || b.rank - a.rank || a.order - b.order)
  for (const candidate of ordered) {
    const media = matched(candidate.range)
    if (media !== undefined) return chosen(repOf(media, pretty))
  }
  return refuse(NOT_ACCEPTABLE, "no representation acceptable to the request")
}

const prettyOf = (value: string | undefined): boolean | undefined => {
  const trimmed = (value ?? "").trim().toLowerCase()
  if (trimmed.length === 0 || trimmed === "false") return false
  return trimmed === "true" ? true : undefined
}

export const choose = (ask: Ask): Choice => {
  const pretty = prettyOf(ask.pretty)
  if (pretty === undefined) {
    return refuse(400, "pretty parameter not understood")
  }
  const format = (ask.format ?? "").trim().toLowerCase()
  if (format.length > 0) {
    const media = named(format)
    return media === undefined
      ? refuse(400, `format not supported: ${format}`)
      : chosen(repOf(media, pretty))
  }
  const accept = (ask.accept ?? "").trim()
  return accept.length === 0
    ? { kind: "serve", rep: { ...DEFAULT, pretty } }
    : fromAccept(accept, pretty)
}

export const tagsOf = (stamp: Stamp): Tags => {
  const at = new Date(stamp.lastUpdated)
  return {
    etag: etagOf(stamp.versionId),
    lastModified: Number.isNaN(at.getTime()) ? undefined : at.toUTCString()
  }
}

const freshness = (notModified: boolean): Freshness => ({
  notModified,
  status: notModified ? NOT_MODIFIED : OK
})

const opaque = (tag: string): string => {
  const trimmed = tag.trim()
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed
}

export const freshnessOf = (
  tags: Tags,
  conditions: Conditions
): Freshness => {
  const match = (conditions.ifNoneMatch ?? "").trim()
  if (match.length > 0) {
    const given = match.split(",").map(opaque)
    return freshness(given.includes("*") || given.includes(opaque(tags.etag)))
  }
  const since = conditions.ifModifiedSince
  const changed = tags.lastModified
  if (since === undefined || changed === undefined) return freshness(false)
  const asked = new Date(since).getTime()
  const written = new Date(changed).getTime()
  if (Number.isNaN(asked) || Number.isNaN(written)) return freshness(false)
  return freshness(written <= asked)
}

const headersOf = (
  rep: Representation,
  tags: Tags | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": `${rep.mediaType}; charset=utf-8`
  }
  if (tags === undefined) return headers
  headers["etag"] = tags.etag
  if (tags.lastModified !== undefined) {
    headers["last-modified"] = tags.lastModified
  }
  return headers
}

export const refusedOf = (refusal: Refusal): Answer => {
  const text = JSON.stringify(toOutcome(refusal.failure))
  const headers = headersOf(DEFAULT, undefined)
  headers["content-length"] = String(Buffer.byteLength(text))
  return { status: refusal.status, headers, body: text }
}

export const answerOf = (
  rep: Representation,
  status: number,
  body: unknown,
  tags?: Tags
): Answer => {
  if (!rep.served) {
    return refusedOf({
      status: NOT_ACCEPTABLE,
      failure: new Rejected({
        reason: `representation not written here: ${rep.mediaType}`
      })
    })
  }
  const text = rep.pretty
    ? JSON.stringify(body, undefined, 2)
    : JSON.stringify(body)
  const headers = headersOf(rep, tags)
  headers["content-length"] = String(Buffer.byteLength(text))
  return { status, headers, body: text }
}

export const outcomeOf = (rep: Representation, failure: Failure): Answer =>
  answerOf(rep, statusOf(failure), toOutcome(failure))

export const notModifiedOf = (rep: Representation, tags: Tags): Answer => ({
  status: NOT_MODIFIED,
  headers: headersOf(rep, tags),
  body: ""
})
