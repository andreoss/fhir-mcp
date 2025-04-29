import { toOutcome } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type { ArgsError } from "./args.js"
import type { Refused } from "./guard.js"

export type ToolError = ArgsError | Refused | Failure

export interface Outcome {
  readonly status: number
  readonly lines: ReadonlyArray<string>
}

const FAILURES: ReadonlySet<string> = new Set([
  "NotFound",
  "Gone",
  "Rejected",
  "Forbidden",
  "Conflict",
  "Unavailable"
])

export const emit = (value: unknown, status = 0): Outcome => ({
  status,
  lines: [JSON.stringify(value)]
})

export const explain = (error: ToolError): string =>
  FAILURES.has(error._tag)
    ? toOutcome(error as Failure).issue[0]?.diagnostics ?? error._tag
    : error.message

export const storePath = (
  given: string | undefined,
  env: Record<string, string | undefined>
): string => {
  const named = given ?? env["FHIR_STORE_PATH"] ?? ""
  const trimmed = named.trim()
  return trimmed.length > 0 ? trimmed : ":memory:"
}
