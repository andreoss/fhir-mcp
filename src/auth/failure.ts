import { Data } from "effect"
import { statusOf, toOutcome } from "../core/outcome.js"
import type { Failure, OperationOutcome } from "../core/outcome.js"

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly reason: string
}> {}

export type Denial = Failure | Unauthorized

export const status = (denial: Denial): number =>
  denial._tag === "Unauthorized" ? 401 : statusOf(denial)

export const outcome = (denial: Denial): OperationOutcome =>
  denial._tag === "Unauthorized"
    ? {
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "forbidden", diagnostics: denial.reason }]
    }
    : toOutcome(denial)
