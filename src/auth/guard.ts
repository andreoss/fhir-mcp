import { Effect } from "effect"
import { Forbidden, Rejected } from "../core/outcome.js"
import { Audit, event } from "./audit.js"
import type { Denial } from "./failure.js"
import { allows, covers } from "./scope.js"
import type { Action, Grant, Kind } from "./scope.js"

const NEEDS: Readonly<Record<string, Action>> = {
  read: "read",
  search: "read",
  history: "read",
  capabilities: "read",
  create: "write",
  update: "write",
  patch: "write",
  delete: "write",
  export: "export",
  import: "import",
  reindex: "reindex",
  "bulk-delete": "bulk-delete",
  "bulk-update": "bulk-update",
  "search-parameter": "parameter-management"
}

export const action = (tool: string): Action | undefined => NEEDS[tool]

export interface Call {
  readonly tool: string
  readonly type: string
  readonly id?: string | undefined
  readonly kind?: Kind | undefined
  readonly compartment?: string | undefined
  readonly parameters?: ReadonlyArray<string> | undefined
  readonly correlation: string
  readonly token?: string | undefined
}

export const listed = <T extends { readonly name: string }>(
  surface: ReadonlyArray<T>,
  grant: Grant
): ReadonlyArray<T> =>
  surface.filter((tool) => {
    const needed = action(tool.name)
    return needed !== undefined && covers(grant, needed)
  })

export const permit = (grant: Grant, call: Call): Effect.Effect<Action, Denial, Audit> =>
  Effect.gen(function* () {
    const needed = action(call.tool)
    if (needed === undefined) {
      return yield* Effect.fail(new Rejected({ reason: `unknown tool: ${call.tool}` }))
    }
    const trail = yield* Audit
    const permitted = allows(grant, {
      action: needed,
      type: call.type,
      kind: call.kind,
      compartment: call.compartment,
      parameters: call.parameters
    })
    trail.write(event({
      correlation: call.correlation,
      action: needed,
      type: call.type,
      id: call.id,
      outcome: permitted ? "success" : "refused",
      token: call.token
    }))
    if (!permitted) {
      return yield* Effect.fail(new Forbidden({ action: `${needed} ${call.type}` }))
    }
    return needed
  })
