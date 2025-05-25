import { Schema } from "effect"

export type Pair = readonly [string, string]

export type Given = { readonly [name: string]: string | ReadonlyArray<string> }

export type Scope = "instance" | "type"

const Value = Schema.Union(Schema.String, Schema.Array(Schema.String))

export const Parameters = Schema.optionalWith(
  Schema.Record({ key: Schema.String, value: Value }),
  { default: (): Given => ({}) }
)

export const OperationName = Schema.String.pipe(
  Schema.pattern(/^\$[a-z][a-z0-9-]{0,62}$/)
).annotations({ message: () => "operation: expected an operation name" })

export const flatten = (given: Given): ReadonlyArray<Pair> => {
  const out: Array<Pair> = []
  for (const [name, value] of Object.entries(given)) {
    if (typeof value === "string") out.push([name, value])
    else for (const one of value) out.push([name, one])
  }
  return out
}

interface Named {
  readonly type: string
  readonly scope: Scope
}

const NAMED: Record<string, Named> = {
  $everything: { type: "Patient", scope: "instance" },
  $docref: { type: "DocumentReference", scope: "type" }
}

export const named = (): ReadonlyArray<string> => Object.keys(NAMED)

export const refusal = (
  name: string,
  type: string,
  scope: Scope
): string | undefined => {
  const known = NAMED[name]
  if (known === undefined) return `unknown operation: ${name}`
  if (known.type !== type) return `${name} is not defined on ${type}`
  if (known.scope === scope) return undefined
  return known.scope === "instance"
    ? `${name} needs a resource id`
    : `${name} takes no resource id`
}
