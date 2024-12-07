import { Data } from "effect"

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly type: string
  readonly id: string
}> {}

export class Gone extends Data.TaggedError("Gone")<{
  readonly type: string
  readonly id: string
}> {}

export class Rejected extends Data.TaggedError("Rejected")<{
  readonly reason: string
}> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly action: string
}> {}

export class Conflict extends Data.TaggedError("Conflict")<{
  readonly reason: string
}> {}

export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly dependency: string
}> {}

export type Failure = NotFound | Gone | Rejected | Forbidden | Conflict | Unavailable

export type IssueCode =
  | "not-found"
  | "deleted"
  | "invalid"
  | "forbidden"
  | "conflict"
  | "transient"

export interface Issue {
  readonly severity: "error"
  readonly code: IssueCode
  readonly diagnostics: string
}

export interface OperationOutcome {
  readonly resourceType: "OperationOutcome"
  readonly issue: ReadonlyArray<Issue>
}

const rendered = (failure: Failure): { readonly code: IssueCode; readonly status: number; readonly diagnostics: string } => {
  switch (failure._tag) {
    case "NotFound":
      return { code: "not-found", status: 404, diagnostics: `${failure.type}/${failure.id} not found` }
    case "Gone":
      return { code: "deleted", status: 410, diagnostics: `${failure.type}/${failure.id} deleted` }
    case "Rejected":
      return { code: "invalid", status: 400, diagnostics: failure.reason }
    case "Forbidden":
      return { code: "forbidden", status: 403, diagnostics: `not permitted: ${failure.action}` }
    case "Conflict":
      return { code: "conflict", status: 409, diagnostics: failure.reason }
    case "Unavailable":
      return { code: "transient", status: 503, diagnostics: `${failure.dependency} unavailable` }
  }
}

export const toOutcome = (failure: Failure): OperationOutcome => {
  const { code, diagnostics } = rendered(failure)
  return { resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] }
}

export const statusOf = (failure: Failure): number => rendered(failure).status
