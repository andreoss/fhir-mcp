import { Effect, Either } from "effect"
import { Rejected, toOutcome } from "../core/outcome.js"
import type { Failure, Issue, OperationOutcome } from "../core/outcome.js"
import { TerminologyPort } from "../terminology/port.js"
import type { Contains } from "../terminology/port.js"
import { allow, covers } from "./grant.js"
import type { Grant } from "./grant.js"

export type Verdict = "ok" | "failed" | "unchecked"

export type Rule = "profile" | "cardinality" | "binding"

export interface Finding {
  readonly path: string
  readonly rule: Rule
  readonly verdict: Verdict
  readonly detail: string
}

export interface Binding {
  readonly path: string
  readonly valueSet: string
  readonly strength: "required" | "extensible"
}

export interface Profile {
  readonly url: string
  readonly type: string
  readonly must: ReadonlyArray<string>
  readonly binds: ReadonlyArray<Binding>
}

export type Catalogue = ReadonlyArray<Profile>

interface Coded {
  readonly system?: string
  readonly code: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nodesAt = (value: unknown, path: ReadonlyArray<string>): ReadonlyArray<unknown> => {
  if (path.length === 0) return value === undefined ? [] : [value]
  if (Array.isArray(value)) return value.flatMap((item) => nodesAt(item, path))
  if (!isRecord(value)) return []
  return nodesAt(value[String(path[0])], path.slice(1))
}

const codesIn = (node: unknown): ReadonlyArray<Coded> => {
  if (typeof node === "string") return [{ code: node }]
  if (Array.isArray(node)) return node.flatMap(codesIn)
  if (!isRecord(node)) return []
  const coding = node["coding"]
  if (Array.isArray(coding)) return coding.flatMap(codesIn)
  const code = node["code"]
  if (typeof code !== "string") return []
  const system = node["system"]
  return [typeof system === "string" ? { system, code } : { code }]
}

const flatten = (list: ReadonlyArray<Contains>): ReadonlyArray<Coded> =>
  list.flatMap((one) => [
    { system: one.system, code: one.code },
    ...flatten(one.contains ?? [])
  ])

const declaredIn = (body: Record<string, unknown>): ReadonlyArray<unknown> => {
  const meta = body["meta"]
  if (!isRecord(meta)) return []
  const held = meta["profile"]
  return Array.isArray(held) ? held : []
}

const finding = (path: string, rule: Rule, verdict: Verdict, detail: string): Finding => ({
  path,
  rule,
  verdict,
  detail
})

const held = (set: ReadonlyArray<Coded>, code: Coded): boolean =>
  set.some(
    (one) => one.code === code.code && (code.system === undefined || one.system === code.system)
  )

const bound = (
  type: string,
  binding: Binding,
  body: Record<string, unknown>
): Effect.Effect<ReadonlyArray<Finding>, Failure, TerminologyPort> =>
  Effect.gen(function* () {
    const at = `${type}.${binding.path}`
    const codes = nodesAt(body, binding.path.split(".")).flatMap(codesIn)
    if (codes.length === 0) return []
    const terminology = yield* TerminologyPort
    const found = yield* Effect.either(terminology.expand({ url: binding.valueSet }))
    if (Either.isLeft(found)) {
      const why = toOutcome(found.left).issue[0]?.diagnostics ?? "no reason given"
      return [
        finding(at, "binding", "unchecked", `${binding.valueSet} was not resolved: ${why}`)
      ]
    }
    const set = flatten(found.right.expansion.contains)
    const systems = new Set(set.map((one) => one.system))
    return codes.map((code) => {
      if (held(set, code)) return finding(at, "binding", "ok", `in ${binding.valueSet}`)
      if (
        binding.strength === "extensible" &&
        code.system !== undefined &&
        !systems.has(code.system)
      ) {
        return finding(at, "binding", "ok", `outside the systems ${binding.valueSet} draws on`)
      }
      return finding(at, "binding", "failed", `${code.code} is not in ${binding.valueSet}`)
    })
  })

export const profiles = (
  type: string,
  body: unknown,
  catalogue: Catalogue,
  grant: Grant
): Effect.Effect<ReadonlyArray<Finding>, Failure, TerminologyPort> =>
  Effect.gen(function* () {
    yield* allow(covers(grant, type), `$validate of ${type}`)
    if (!isRecord(body) || body["resourceType"] !== type) {
      return yield* Effect.fail(new Rejected({ reason: `body does not carry ${type}` }))
    }
    const at = `${type}.meta.profile`
    const out: Array<Finding> = []
    for (const one of declaredIn(body)) {
      if (typeof one !== "string") {
        out.push(finding(at, "profile", "failed", "a profile is named by a canonical url"))
        continue
      }
      const profile = catalogue.find((known) => known.url === one)
      if (profile === undefined) {
        out.push(finding(at, "profile", "unchecked", `no definition held here for ${one}`))
        continue
      }
      if (profile.type !== type) {
        out.push(finding(at, "profile", "failed", `${one} is written for ${profile.type}`))
        continue
      }
      for (const path of profile.must) {
        if (nodesAt(body, path.split(".")).length === 0) {
          out.push(finding(`${type}.${path}`, "cardinality", "failed", `${one} requires ${path}`))
        }
      }
      for (const binding of profile.binds) out.push(...(yield* bound(type, binding, body)))
    }
    return out
  })

export const settled = (found: ReadonlyArray<Finding>): boolean =>
  found.every((one) => one.verdict === "ok")

export const outcomeOf = (found: ReadonlyArray<Finding>): OperationOutcome => ({
  resourceType: "OperationOutcome",
  issue: found
    .filter((one) => one.verdict !== "ok")
    .map(
      (one): Issue => ({
        severity: "error",
        code: one.verdict === "unchecked" ? "not-found" : "invalid",
        diagnostics: `${one.path}: ${one.rule}: ${one.verdict}: ${one.detail}`
      })
    )
})

export const enforceProfiles = (
  type: string,
  body: unknown,
  catalogue: Catalogue,
  grant: Grant
): Effect.Effect<void, Failure, TerminologyPort> =>
  Effect.flatMap(profiles(type, body, catalogue, grant), (found) =>
    settled(found)
      ? Effect.void
      : Effect.fail(
          new Rejected({
            reason: outcomeOf(found)
              .issue.map((one) => one.diagnostics)
              .join("; ")
          })
        )
  )
