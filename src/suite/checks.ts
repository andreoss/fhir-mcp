import { providerOf } from "../conformance/capability.js"
import type { CapabilityStatement } from "../conformance/capability.js"

export type Check =
  | { readonly id: string; readonly kind: "tool"; readonly tool: string }
  | { readonly id: string; readonly kind: "type"; readonly type: string }
  | {
    readonly id: string
    readonly kind: "param"
    readonly type: string
    readonly param: string
  }

export interface Observed {
  readonly tools: ReadonlyArray<string>
  readonly types: ReadonlyArray<string>
  readonly params: Readonly<Record<string, ReadonlyArray<string>>>
}

export interface Verdict {
  readonly id: string
  readonly met: boolean
}

export const checksOf = (
  found: CapabilityStatement,
  offered: ReadonlyArray<string> = []
): ReadonlyArray<Check> => {
  const made = new Map<string, Check>()
  const covered = new Set<string>()
  const tool = (id: string, name: string) => {
    covered.add(name)
    made.set(id, { id, kind: "tool", tool: name })
  }
  for (const rest of found.rest) {
    for (const one of rest.interaction) {
      const provider = providerOf(one.code)
      if (provider !== undefined) tool(`system:${one.code}`, provider)
    }
    for (const entry of rest.resource) {
      const id = `type:${entry.type}`
      made.set(id, { id, kind: "type", type: entry.type })
      for (const one of entry.interaction) {
        const provider = providerOf(one.code)
        if (provider !== undefined) tool(`interaction:${one.code}`, provider)
      }
      for (const param of entry.searchParam) {
        const named = `param:${entry.type}.${param.name}`
        made.set(named, { id: named, kind: "param", type: entry.type, param: param.name })
      }
    }
  }
  for (const name of offered) {
    if (covered.has(name)) continue
    made.set(`tool:${name}`, { id: `tool:${name}`, kind: "tool", tool: name })
  }
  return [...made.values()].sort((a, b) => a.id.localeCompare(b.id))
}

const met = (check: Check, seen: Observed): boolean => {
  if (check.kind === "tool") return seen.tools.includes(check.tool)
  if (check.kind === "type") return seen.types.includes(check.type)
  return (seen.params[check.type] ?? []).includes(check.param)
}

export const verify = (
  checks: ReadonlyArray<Check>,
  seen: Observed
): ReadonlyArray<Verdict> => checks.map((check) => ({ id: check.id, met: met(check, seen) }))
