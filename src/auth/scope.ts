import { Effect } from "effect"
import { Forbidden } from "../core/outcome.js"

export type Action =
  | "read"
  | "write"
  | "export"
  | "import"
  | "reindex"
  | "bulk-delete"
  | "bulk-update"
  | "parameter-management"

export type Kind = "patient" | "user" | "system"

export const ACTIONS: ReadonlyArray<Action> = [
  "read",
  "write",
  "export",
  "import",
  "reindex",
  "bulk-delete",
  "bulk-update",
  "parameter-management"
]

const RANK: Readonly<Record<Kind, number>> = { patient: 0, user: 1, system: 2 }

const SHAPE =
  /^(patient|user|system)(?::([A-Za-z0-9\-.]{1,64}))?\/([A-Za-z][A-Za-z0-9]{0,63}|\*)\.([a-z-]+|\*)(?:\?([A-Za-z0-9_,\-]+))?$/

export interface Scope {
  readonly kind: Kind
  readonly compartment: string | undefined
  readonly type: string
  readonly action: Action | "*"
  readonly parameters: ReadonlyArray<string> | undefined
}

export interface Grant {
  readonly scopes: ReadonlyArray<Scope>
}

export interface Access {
  readonly action: Action
  readonly type: string
  readonly kind?: Kind | undefined
  readonly compartment?: string | undefined
  readonly parameters?: ReadonlyArray<string> | undefined
}

const asAction = (value: string): Action | "*" | undefined =>
  value === "*"
    ? "*"
    : (ACTIONS as ReadonlyArray<string>).includes(value)
    ? (value as Action)
    : undefined

const parse = (raw: string): Scope | undefined => {
  const found = SHAPE.exec(raw.trim())
  if (found === null) return undefined
  const kind = found[1]
  const type = found[3]
  const named = found[4]
  if (kind === undefined || type === undefined || named === undefined) return undefined
  const action = asAction(named)
  if (action === undefined) return undefined
  const parameters = found[5]
  return {
    kind: kind as Kind,
    compartment: found[2],
    type,
    action,
    parameters: parameters === undefined
      ? undefined
      : parameters.split(",").filter((name) => name.length > 0)
  }
}

export const grant = (raw: ReadonlyArray<string>): Grant => ({
  scopes: raw.map(parse).filter((scope): scope is Scope => scope !== undefined)
})

const covered = (scope: Scope, access: Access): boolean => {
  if (scope.action !== "*" && scope.action !== access.action) return false
  if (scope.type !== "*" && scope.type !== access.type) return false
  if (RANK[scope.kind] < RANK[access.kind ?? "user"]) return false
  if (scope.compartment !== undefined && scope.compartment !== access.compartment) return false
  const named = scope.parameters
  if (named !== undefined && !(access.parameters ?? []).every((name) => named.includes(name))) {
    return false
  }
  return true
}

export const allows = (grant: Grant, access: Access): boolean =>
  grant.scopes.some((scope) => covered(scope, access))

export const covers = (grant: Grant, action: Action): boolean =>
  grant.scopes.some((scope) => scope.action === "*" || scope.action === action)

export const check = (grant: Grant, access: Access): Effect.Effect<void, Forbidden> =>
  allows(grant, access)
    ? Effect.void
    : Effect.fail(new Forbidden({ action: `${access.action} ${access.type}` }))
