import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { FhirResource } from "../core/engine.js"

export const MASK = "masked"

const KEPT = new Set(["id", "resourceType"])

export const ActDoc = Schema.Literal("redact", "mask", "hash")

export const RuleDoc = Schema.Struct({ path: Schema.String, act: ActDoc })

export const SealedDoc = Schema.Struct({
  location: Schema.String,
  etag: Schema.String,
  rules: Schema.Array(RuleDoc)
})

export const SetDoc = Schema.Struct({
  location: Schema.String,
  rules: Schema.Array(RuleDoc)
})

export type Act = typeof ActDoc.Type

export type Rule = typeof RuleDoc.Type

export type Sealed = typeof SealedDoc.Type

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

export const seal = (
  location: string,
  rules: ReadonlyArray<Rule>
): Sealed => ({
  location,
  etag: `W/"${digest(JSON.stringify(rules)).slice(0, 12)}"`,
  rules
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const masked = (act: Act, value: unknown): unknown => {
  if (act === "mask") return MASK
  if (typeof value === "string" || typeof value === "number") {
    return digest(String(value)).slice(0, 16)
  }
  return undefined
}

const edit = (
  node: Record<string, unknown>,
  path: ReadonlyArray<string>,
  act: Act
): void => {
  const [head, ...rest] = path
  if (head === undefined || KEPT.has(head)) return
  const held = node[head]
  if (held === undefined) return
  if (rest.length === 0) {
    const next = act === "redact" ? undefined : masked(act, held)
    if (next === undefined) delete node[head]
    else node[head] = next
    return
  }
  for (const item of Array.isArray(held) ? held : [held]) {
    if (isRecord(item)) edit(item, rest, act)
  }
}

export const apply = (sealed: Sealed, body: FhirResource): FhirResource => {
  if (sealed.rules.length === 0) return body
  const draft = structuredClone(body) as Record<string, unknown>
  for (const rule of sealed.rules) edit(draft, rule.path.split("."), rule.act)
  return draft as FhirResource
}
