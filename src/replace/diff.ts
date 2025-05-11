import type { Answer, Pair, Request, Run } from "./shadow.js"

export type Kind = "only-left" | "only-right" | "field" | "count" | "error"

export type Severity = "critical" | "major" | "minor"

export interface Divergence {
  readonly kind: Kind
  readonly severity: Severity
  readonly request: Request
  readonly detail: string
}

export interface Report {
  readonly left: string
  readonly right: string
  readonly of: number
  readonly divergence: ReadonlyArray<Divergence>
  readonly byKind: Record<Kind, number>
  readonly bySeverity: Record<Severity, number>
}

export const KINDS: ReadonlyArray<Kind> = [
  "only-left",
  "only-right",
  "field",
  "count",
  "error"
]

export const SEVERITY: Record<Kind, Severity> = {
  "only-left": "critical",
  "only-right": "critical",
  field: "major",
  count: "major",
  error: "major"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const paths = (
  left: unknown,
  right: unknown,
  at: ReadonlyArray<string>
): ReadonlyArray<string> => {
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    return keys.flatMap((key) => paths(left[key], right[key], [...at, key]))
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const span = Math.max(left.length, right.length)
    return [...Array(span).keys()].flatMap((index) =>
      paths(left[index], right[index], [...at, String(index)])
    )
  }
  const alike = JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  return alike ? [] : [at.join(".")]
}

const severityOf = (kind: Kind, path: string): Severity =>
  kind === "field" && path.startsWith("meta") ? "minor" : SEVERITY[kind]

const found = (
  kind: Kind,
  request: Request,
  detail: string,
  path = ""
): Divergence => ({ kind, severity: severityOf(kind, path), request, detail })

const present = (answer: Answer): boolean => answer.of !== "failure"

const sets = (
  request: Request,
  left: { readonly total: number; readonly id: ReadonlyArray<string> },
  right: { readonly total: number; readonly id: ReadonlyArray<string> },
  names: readonly [string, string]
): ReadonlyArray<Divergence> => {
  const out: Array<Divergence> = []
  if (left.total !== right.total) {
    out.push(
      found(
        "count",
        request,
        `total is ${left.total} on ${names[0]} and ${right.total} on ${names[1]}`
      )
    )
  }
  const held = new Set(right.id)
  const mirror = new Set(left.id)
  for (const id of left.id.filter((one) => !held.has(one))) {
    out.push(found("only-left", request, `${request.type}/${id} only on ${names[0]}`))
  }
  for (const id of right.id.filter((one) => !mirror.has(one))) {
    out.push(found("only-right", request, `${request.type}/${id} only on ${names[1]}`))
  }
  return out
}

export const compare = (
  left: string,
  right: string,
  pair: Pair
): ReadonlyArray<Divergence> => {
  const names = [left, right] as const
  const here = pair.left
  const there = pair.right
  if (present(here) && !present(there)) {
    return [found("only-left", pair.request, `answered on ${left}, refused on ${right}`)]
  }
  if (!present(here) && present(there)) {
    return [found("only-right", pair.request, `answered on ${right}, refused on ${left}`)]
  }
  if (here.of !== there.of) {
    return [
      {
        kind: "error",
        severity: "critical",
        request: pair.request,
        detail: `answer is ${here.of} on ${left} and ${there.of} on ${right}`
      }
    ]
  }
  if (here.of === "failure" && there.of === "failure") {
    return here.tag === there.tag
      ? []
      : [
          found(
            "error",
            pair.request,
            `failure is ${here.tag} on ${left} and ${there.tag} on ${right}`
          )
        ]
  }
  if (here.of === "set" && there.of === "set") return sets(pair.request, here, there, names)
  if (here.of === "resource" && there.of === "resource") {
    return paths(here.body, there.body, []).map((path) =>
      found("field", pair.request, `field differs at ${path}`, path)
    )
  }
  return []
}

const zero = <A extends string>(keys: ReadonlyArray<A>): Record<A, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<A, number>

export const report = (run: Run): Report => {
  const divergence = run.pair.flatMap((pair) => compare(run.left, run.right, pair))
  const byKind = zero(KINDS)
  const bySeverity = zero<Severity>(["critical", "major", "minor"])
  for (const one of divergence) {
    byKind[one.kind] = byKind[one.kind] + 1
    bySeverity[one.severity] = bySeverity[one.severity] + 1
  }
  return {
    left: run.left,
    right: run.right,
    of: run.pair.length,
    divergence,
    byKind,
    bySeverity
  }
}
