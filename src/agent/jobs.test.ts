import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { Jobs } from "../jobs/service.js"
import type { Desk, Status, Ticket } from "../jobs/service.js"
import { Journal } from "./audit.js"
import type { Entry, Ledger } from "./audit.js"
import { callJob, jobTools } from "./jobs.js"
import { JOB_RULES } from "./rules.js"
import type { ToolResult } from "./tools.js"

const TICKET: Ticket = { id: "j1", location: "/jobs/j1", retryAfter: 5 }

const STATUS: Status = {
  id: "j1",
  kind: "reindex",
  state: "queued",
  location: "/jobs/j1",
  retryAfter: 5,
  total: 1,
  pending: 1,
  done: 0,
  failed: 0,
  cancelled: 0,
  detail: undefined
}

interface Seen {
  readonly calls: Array<string>
  readonly notes: Array<Entry>
}

const faked = (
  seen: Seen,
  over: Partial<Desk> = {}
): Layer.Layer<Jobs | Journal> =>
  Layer.merge(
    Layer.succeed(Jobs, {
      submit: (kind, request) => {
        seen.calls.push(`submit:${kind}:${request}`)
        return Effect.succeed(TICKET)
      },
      status: (id) => {
        seen.calls.push(`status:${id}`)
        return Effect.succeed({ ...STATUS, id })
      },
      cancel: (id) => {
        seen.calls.push(`cancel:${id}`)
        return Effect.void
      },
      ...over
    } satisfies Desk),
    Layer.succeed(Journal, {
      note: (entry) =>
        Effect.sync(() => {
          seen.notes.push(entry)
        })
    } satisfies Ledger)
  )

const answered = (
  seen: Seen,
  name: string,
  args: unknown,
  over: Partial<Desk> = {}
): Promise<ToolResult> =>
  Effect.runPromise(
    Effect.provide(callJob(name, args), faked(seen, over))
  )

const first = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>

describe("JOB-02 job tools on the served surface", () => {
  it("serves one tool per step of an asynchronous job", () => {
    expect(jobTools.map((tool) => tool.name)).toEqual([
      "job-submit",
      "job-status",
      "job-cancel"
    ])
  })

  it("carries the operating rules in every description", () => {
    for (const tool of jobTools) {
      expect(tool.description).toContain(JOB_RULES)
      expect(tool.description).toContain(tool.name)
    }
  })

  it("names the kinds a submission may ask for", () => {
    const submit = jobTools.find((tool) => tool.name === "job-submit")
    const kind = (submit?.inputSchema.properties["kind"] ?? {}) as { enum?: ReadonlyArray<string> }
    expect(kind.enum).toEqual(["import", "export", "bulk-delete", "bulk-update", "reindex"])
    expect(submit?.inputSchema.required).toEqual(["kind", "request"])
  })

  it("annotates a submission as destructive and a poll as read only", () => {
    const submit = jobTools.find((tool) => tool.name === "job-submit")
    const poll = jobTools.find((tool) => tool.name === "job-status")
    expect(submit?.annotations.destructiveHint).toBe(true)
    expect(submit?.annotations.idempotentHint).toBe(false)
    expect(poll?.annotations.destructiveHint).toBe(false)
    expect(poll?.annotations.idempotentHint).toBe(true)
  })

  it("answers a submission with a status location and a retry hint", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", {
      kind: "reindex",
      request: '{"type":"Patient"}'
    })
    expect(result.isError).toBe(false)
    expect(first(result)).toEqual({ ...TICKET })
    expect(seen.calls).toEqual(['submit:reindex:{"type":"Patient"}'])
  })

  it("answers a poll with the state of the job", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-status", { id: "j1" })
    expect(result.isError).toBe(false)
    expect(first(result)).toEqual({ ...STATUS })
    expect(seen.calls).toEqual(["status:j1"])
  })

  it("answers a cancellation with the state it left behind", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-cancel", { id: "j1" }, {
      status: (id) => {
        seen.calls.push(`status:${id}`)
        return Effect.succeed({ ...STATUS, id, state: "cancelled", retryAfter: undefined })
      }
    })
    expect(result.isError).toBe(false)
    expect(first(result)["state"]).toBe("cancelled")
    expect(seen.calls).toEqual(["cancel:j1", "status:j1"])
  })

  it("refuses a kind the desk does not carry as an outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", { kind: "explode", request: "{}" })
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(JSON.stringify(result.content)).toContain("kind")
    expect(seen.calls).toEqual([])
  })

  it("refuses a poll without a job id as an outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-status", {})
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(seen.calls).toEqual([])
  })

  it("reports a refusal of the desk as an outcome, not as a crash", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", { kind: "import", request: "{}" }, {
      submit: () => Effect.fail(new Rejected({ reason: "import splits into no unit of work" }))
    })
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(JSON.stringify(result.content)).toContain("no unit of work")
  })

  it("refuses a tool it does not serve as an outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-explode", {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("unknown tool")
  })

  it("journals every call with its tool and outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    await answered(seen, "job-status", { id: "j1" })
    expect(seen.notes.map((note) => [note.tool, note.outcome])).toEqual([
      ["job-status", "success"]
    ])
    expect(seen.notes[0]?.correlation).toBe("none")
  })

  it("journals the outcome without the diagnostics it answered with", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", { kind: "export", request: "{}" }, {
      submit: (): Effect.Effect<Ticket, Failure> =>
        Effect.fail(new Rejected({ reason: "export splits into no unit of work" }))
    })
    expect(seen.notes.map((note) => note.outcome)).toEqual(["refused"])
    expect(JSON.stringify(seen.notes)).not.toContain("no unit of work")
    expect(JSON.stringify(result.content)).toContain("no unit of work")
  })

  it("needs no journal to answer", async () => {
    const asked: Seen = { calls: [], notes: [] }
    const result = await Effect.runPromise(
      Effect.provide(
        callJob("job-status", { id: "j1" }),
        Layer.succeed(Jobs, {
          submit: () => Effect.succeed(TICKET),
          status: () => Effect.succeed(STATUS),
          cancel: () => Effect.void
        } satisfies Desk)
      )
    )
    expect(result.isError).toBe(false)
    expect(asked.calls).toEqual([])
  })
})
